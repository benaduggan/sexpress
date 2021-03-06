const express = require("express")
const session = require("express-session")
const path = require("path")
const fs = require("fs")
const bodyParser = require("body-parser")
const nodemailer = require("nodemailer")
const favicon = require("serve-favicon")
const crypto = require("crypto")
const passport = require("passport")
const refresh = require("passport-oauth2-refresh")
const watch = require("watch")
const http = require("http")
const https = require("https")
const reload = require("reload")
let config = require("clobfig")()

const {
	getRootPath,
	log,
	logger,
	merge,
} = require("./util")(config.AppRoot)

const packageJsonPath = getRootPath("package.json")
const {
	setInterval
} = require("safe-timers")
const {
	Strategy: ImgurStrategy,
} = require("passport-imgur")
const {
	Strategy: RedditStrategy,
} = require("passport-reddit")
const {
	Clobfig
} = require("clobfig")
const {
	version
} = fs.existsSync(packageJsonPath) ? require(packageJsonPath) : {
	version: 'null'
}

const debugFilename = getRootPath("config.debug.js")

const subdomains = !!config.subdomains ?
	Object.keys(config.subdomains) : []
const authTokens = {}

// Never let debug mode run in production
let debug = !!config.debug ? config.debug : process.argv.reduce((out, arg) => out = out || arg.indexOf('--debug=true') !== -1, false)
debug = config.debug = process.env.NODE_ENV !== "production" ? debug : false

if (debug && fs.existsSync(debugFilename)) {
	config = merge(config, merge(require(debugFilename), {
		host: "localhost",
		port: 8080,
		sslport: 8443,
		version,
	}))
}

/// TODO: refactor this request to only use the data from the data folder, with whatever else is required, instead of chunking out the data from the config
const getPublicConfigurationValues = (
	opts,
	subdomain,
	host
) => {
	const publicConfig = {
		host,
		SUBDOMAIN: subdomain.toUpperCase(),
		thisSubdomain: subdomain,
		debug: opts.debug,
		content: opts.content,
	}

	publicConfig.subdomains = Object.values(
		opts.subdomains
	).reduce((out, subdomainInformation, index) => {
		const subdomainName = subdomains[index]
		const customCssPath = path.join(
			__dirname,
			"assets/css",
			`${subdomain}.css`
		)
		const hasCustomCss = fs.existsSync(customCssPath)

		const pageData = {
			images: subdomainInformation.images,
			adminEmailAddresses: subdomainInformation.adminEmailAddresses,
			metaUrl: subdomainInformation.metaUrl || opts.metaUrl,
			metaType: subdomainInformation.metaType || opts.metaType,
			metaTitle: subdomainInformation.metaTitle || opts.metaTitle,
			metaDescription: subdomainInformation.metaDescription ||
				opts.metaDescription,
			gaUA: subdomainInformation.gaUA || opts.defaults.gaUA,
			hasCustomCss,
		}

		out[subdomainName] = pageData

		if (subdomain === subdomainName) {
			publicConfig.page = pageData
		}

		return out
	}, {})

	publicConfig.content = opts.content

	return opts.publicConfigFilter(
		publicConfig,
		opts,
		subdomain
	)
}

const getSubdomainPrefix = (
	opts,
	req,
	returnAlias = false
) => {
	const defaultSubdomain = req.subdomains.length ?
		req.subdomains[0] :
		"default"
	const localhostSubdomainEnd = !!req.headers.host ?
		req.headers.host.indexOf(".") :
		-1
	const localhostOverride =
		localhostSubdomainEnd !== -1 ?
		req.headers.host.substr(0, localhostSubdomainEnd) :
		null
	const alias = !!localhostOverride ?
		localhostOverride :
		defaultSubdomain

	return returnAlias ?
		alias :
		getSubdomainFromAlias(opts, alias)
}

const getSubdomainOpts = (opts, req) => {
	const subdomain = getSubdomainPrefix(opts, req, true)
	let subdomainConfig = {}
	if (!!opts.subdomains[subdomain]) {
		subdomainConfig = opts.subdomains[subdomain]
	} else {
		const subdomainAliased = Object.values(opts.subdomains).filter((sub) => {
			return sub.aliases.indexOf(subdomain) !== -1
		})
		subdomainConfig = subdomainAliased.length ? subdomainAliased[0] : {}
	}

	return {
		requestSubdomain: subdomain,
		...subdomainConfig,
		requestHost: req.hostname,
	}
}

const getSubdomainFromAlias = (opts, alias) => {
	let baseSubdomain

	Object.keys(opts.subdomains).forEach((baseName) => {
		const aliases =
			opts.subdomains[baseName].aliases || []
		if (
			alias === baseName ||
			aliases.indexOf(alias) !== -1
		) {
			baseSubdomain = baseName
			return
		}
	})

	return baseSubdomain
}

function getTemplateNameFromSubdomain(opts, subdomain) {
	if (!!opts.subdomains[subdomain]) {
		return opts.subdomains[subdomain].template
	}

	return null
}

const isValidRequestOrigin = (opts, req) => {
	/// All requests should match this host
	const host = opts.host

	const origin = req.get("origin") || "none"
	const subdomain = getSubdomainPrefix(opts, req, true)
	const subdomainPrefix = `${subdomain == "default" ? "" : `${subdomain}.`}`
	const path = ""
	const protocol = req.protocol
	const reconstructedUrl = `${protocol}://${subdomainPrefix}${host}${path}`

	const localhostPortIsTheSameForDebugging =
		origin === reconstructedUrl ||
		origin === `${reconstructedUrl}:${opts.port}`
	const originIsCorrectSubdomain =
		origin == `${protocol}://${subdomainPrefix}${host}`
	const originIsValid =
		originIsCorrectSubdomain ||
		localhostPortIsTheSameForDebugging

	if (originIsValid) {
		log(`origin ${origin} is valid`)
	} else {
		console.error(`origin ${origin} is not valid`, {
			localhostPortIsTheSameForDebugging,
			originIsCorrectSubdomain,
			reconstructedUrl,
			originIsValid,
			subdomain,
			origin,
		})
	}

	return originIsValid
}

async function sendEmail(
	opts,
	to,
	subject,
	text,
	callback,
	html,
	from
) {
	const configEmailAddressIsSet = !!opts.email.emailAccountAddress
	const configEmailHostIsSet = !!opts.email.emailAccountHost
	const configEmailServiceIsSet = !!opts.email.emailService

	// Generate test SMTP service account from ethereal.email
	// Only needed if you don't have a real mail account for testing
	const auth = configEmailAddressIsSet ? {
			user: opts.email.emailAccountAddress,
			pass: opts.email.emailAccountPassword,
		} :
		await nodemailer.createTestAccount()

	const host = configEmailHostIsSet ?
		opts.email.emailAccountHost :
		"smtp.ethereal.email"
	const port = configEmailHostIsSet ?
		opts.email.emailAccountPort :
		587
	const secure = configEmailHostIsSet ?
		opts.email.emailAccountIsSecure :
		false

	const service = configEmailServiceIsSet ?
		opts.email.emailService :
		null
	from = !!from ? from : auth.user
	let transporter

	if (configEmailServiceIsSet) {
		transporter = nodemailer.createTransport({
			service,
			auth,
		})
	} else {
		// create reusable transporter object using the default SMTP transport
		transporter = nodemailer.createTransport({
			host,
			port,
			secure, // true for 465, false for other ports
			auth,
		})
	}

	// send mail with defined transport object
	const info = await transporter.sendMail({
		from, // sender address
		to, // list of receivers
		subject, // Subject line
		text, // plain text body
		html, // html body
	})

	log("Message sent: %s", info.messageId)

	if (!configEmailAddressIsSet) {
		// Preview only available when sending through an Ethereal account
		log(
			"Preview URL: %s",
			nodemailer.getTestMessageUrl(info)
		)
		// Preview URL: https://ethereal.email/message/WaQKMgKddxQDoou...
	}

	callback(info)
}

const defaults = {
	host: 'localhost',
	run: false,
	initSeqMessage: "Sexy Configuration!",
	publicConfigFilter: (c) => c,
}

class Sexpress {

	constructor(opts = {}) {
		this.app = express()
		this.setConfiguration({
			...defaults,
			...config,
			...opts,
		})

		if (this.config.debug) {
			log(this.config.initSeqMessage, this.config)
		}

		this.init()
		this.logging()
		this.security()
		this.routers()
		this.templating()
		this.authentication()
		this.routes()

		if (this.config.run) {
			this.run()
		}
	}

	setConfiguration(config) {
		this.config = config
		this.config.defaults = this.config.defaults || {}
		this.config.publicFolder = getRootPath("public")
		this.config.contentFolder = getRootPath([
			"public",
			"content",
		])
		this.config.sslFolder = getRootPath([
			"config",
			"ssl",
		])
		this.config.templatesFolder = getRootPath("templates")
		this.config.controllerFolder = getRootPath("api")
		this.config.viewsFolder = getRootPath("views")
		this.config.getRootPath = getRootPath

		const getValuesFromConfig = (
			names,
			input = {},
			defaults = {}
		) => {
			names.forEach((name) => {
				input[name] = !!input[name] ?
					input[name] :
					!!this.config.defaults[name] ?
					this.config.defaults[name] :
					this.config[name]
			})

			// Assign the subdomain based value or use the default from the base cofig
			return input
		}

		for (const subdomain of subdomains) {
			const subdomainConfiguration = this.config.subdomains[
				subdomain
			]

			// Assign the subdomain based imgur authorization information, or use the default
			subdomainConfiguration.imgur = getValuesFromConfig(
				[
					"imgurClientID",
					"imgurClientSecret",
					"imgurCallbackURL",
					"imgurEmailAddress",
				],
				subdomainConfiguration.imgur
			)
			// Assign the subdomain based AWS S3 authorization information, or use the default
			subdomainConfiguration.s3 = getValuesFromConfig(
				[
					"AwsCdnUrl",
					"emailAddress",
					"accessKeyId",
					"secretAccessKey",
					"region",
				],
				subdomainConfiguration.s3
			)
			// Assign the subdomain based Reddit authorization information, or use the default
			subdomainConfiguration.reddit = getValuesFromConfig(
				[
					"redditClientID",
					"redditClientSecret",
					"redditCallbackURL",
					"redditUserName",
					"redditUserAgent",
					"redditPassword",
				],
				subdomainConfiguration.reddit
			)
			// Assign the subdomain based email authorization information, or use the default
			subdomainConfiguration.email = getValuesFromConfig(
				[
					"emailAccountHost",
					"emailService",
					"emailAccountAddress",
					"emailAccountPassword",
					"emailAccountIsSecure",
					"emailAccountPort",
				],
				subdomainConfiguration.email
			)

			authTokens[subdomain] = subdomainConfiguration
		}

		/// Configure SSL for a local file strategy
		const ssl = this.config.ssl || {}
		if (fs.existsSync(this.config.sslFolder)) {
			const sslFiles = fs.readdirSync(
				this.config.sslFolder
			)

			sslFiles.forEach((sslFile) => {
				const sslFileSplit = sslFile.split(".")
				const sslFileName = sslFileSplit[0]
				const sslFileExtension = sslFileSplit[1]

				if (sslFileExtension === "pem") {
					const sslFilePath = path.join(this.config.sslFolder, sslFile)
					switch (sslFileName) {
						case 'cert':
							ssl.hasCertificate = true
							ssl.certificateFilename = sslFilePath
							break
						case 'key':
							ssl.hasCertificateKey = true
							ssl.certificateKeyFilename = sslFilePath
							break
						case 'ca':
							ssl.hasCertificateAuthority = true
							ssl.certificateAuthorityFilename = sslFilePath
						case 'passphrase':
							ssl.passphrase = fs.readFileSync(sslFilePath, 'utf-8')
							break
					}
				}
			})
		}
		this.config.ssl = ssl

		const content = {}
		if (fs.existsSync(this.config.contentFolder)) {
			const contentFiles = fs.readdirSync(
				this.config.contentFolder
			)

			contentFiles.forEach((contentFile) => {
				const contentFileSplit = contentFile.split(".")
				const contentFileName = contentFileSplit[0]
				const contentFileExtension = contentFileSplit[1]

				if (contentFileExtension === "html") {
					const html = fs.readFileSync(
						path.join(
							this.config.contentFolder,
							contentFile
						), {
							encoding: "utf8",
						}
					)
					content[contentFileName] = html
				}
			})
		}

		this.config.content = content
	}

	init() {
		// log(this.config.initSeqMessage)

		this.app.use(
			session({
				secret: this.config.appName,
				resave: false,
				saveUninitialized: true,
			})
		)
		this.app.use(passport.initialize())
		this.app.use(passport.session())
		this.app.use(express.json()) // to support JSON-encoded bodies
		this.app.use(
			express.urlencoded({
				extended: true,
			})
		) // to support URL-encoded bodies

		const faviconFileName = path.join(
			__dirname,
			"public/",
			"favicon.ico"
		)
		if (fs.existsSync(faviconFileName)) {
			this.app.use(favicon(faviconFileName))
		}
	}

	filterSubdomainRequest(
		endpoint,
		response,
		method = "get"
	) {
		this.app[method](endpoint, (req, res, next) => {
			const subdomain = getSubdomainPrefix(this.config, req)
			const host = req.headers.host
			const ip =
				req.headers["x-forwarded-for"] ||
				req.connection.remoteAddress

			log("incoming request", {
				url: req.url,
				subdomain,
				ip,
			})

			return response(subdomain, req, res, host, next)
		})
	}

	getTemplateNameFromSubdomain(subdomain) {
		return getTemplateNameFromSubdomain(
			this.config,
			subdomain
		)
	}

	renderTemplate(template, data, res) {
		const pageTemplate = path.join(
			this.config.templatesFolder,
			template,
			"index"
		)
		if (
			this.config.supportRendering &&
			fs.existsSync(`${pageTemplate}.ejs`)
		) {
			// log('rendering template', { data, pageTemplate })
			return res.render(pageTemplate, data)
		}

		const pageFile = `${pageTemplate}.html`
		if (fs.existsSync(pageFile)) {
			log("serving html file", pageFile)
			return res.sendFile(pageFile)
			/// TODO: Send data somehow?
		}

		log("could not render template", template)
	}

	getPublicConfigurationValues(subdomain, host) {
		return getPublicConfigurationValues(
			this.config,
			subdomain,
			host
		)
	}

	isValidRequestOrigin(req) {
		return isValidRequestOrigin(this.config, req)
	}

	getSubdomainOpts(req) {
		return getSubdomainOpts(this.config, req)
	}

	getSubdomainFromAlias(alias) {
		return getSubdomainFromAlias(this.config, alias)
	}

	sendEmail(subdomainConfig, opts = {}) {
		return sendEmail(
			!!subdomainConfig ? subdomainConfig : this.config,
			opts.to,
			opts.subject,
			opts.text,
			opts.callback,
			opts.html,
			opts.from
		)
	}

	logging() {
		// if (this.config.debug) {
		this.app.use(logger("dev"))
		// }
	}

	/// Injects security into protected endpoints
	security() {
		this.app.all("/*", (req, res, next) => {
			const url = req.url

			if (this.config.debug)
				log.info("security check", url)

			// CORS headers
			res.header("Access-Control-Allow-Origin", "*") // restrict it to the required domain
			res.header(
				"Access-Control-Allow-Methods",
				"GET,PUT,POST,OPTIONS"
			)
			// Set custom headers for CORS
			res.header(
				"Access-Control-Allow-Headers",
				"Content-type,Accept,X-Access-Token,X-Key"
			)
			if (req.method == "OPTIONS") {
				console.error("failed security check!", url)
				res.status(200).end()
			} else {
				next()
			}
		})

		log("request security enabled")
	}

	/// Configures routes for the app
	routes() {
		// All public content
		this.app.use(express.static(getRootPath("public")))
	}

	/// adds project functionality to the application
	routers() {
		/// TODO: make this a configurable feature
		if (fs.existsSync(this.config.controllerFolder)) {
			fs.readdirSync(this.config.controllerFolder).forEach(
				(filename) => {
					const file = path.join(
						this.config.controllerFolder,
						filename
					)

					if (!fs.statSync(file).isDirectory()) return

					if (this.config.debug)
						log("\n   %s:", filename)

					const controller = require(file)
					const name = controller.name || filename
					const prefix = controller.prefix || ""
					const applet = express()

					let handler, method, url

					// allow specifying the view engine
					if (controller.engine)
						applet.set("view engine", controller.engine)
					applet.set(
						"views",
						path.join(
							this.config.controllerFolder,
							name,
							"views"
						)
					)

					// generate routes based
					// on the exported methods
					for (const key in controller) {
						// "reserved" exports
						if (
							~[
								"name",
								"prefix",
								"engine",
								"before",
								"routes",
							].indexOf(key)
						)
							continue

						// route exports
						switch (key) {
							case "show":
								method = "get"
								url = "/" + name + "/:" + name + "_id"
								break

							case "list":
								method = "get"
								url = "/" + name + "s"
								break

							case "edit":
								method = "get"
								url = "/" + name + "/:" + name + "_id/edit"
								break

							case "update":
								method = "put"
								url = "/" + name + "/:" + name + "_id"
								break

							case "create":
								method = "post"
								url = "/" + name
								break

							case "index":
								method = "get"
								url = "/"
								break

							default:
								/* istanbul ignore next */
								throw new Error(
									"unrecognized route: " + name + "." + key
								)
						}

						// setup
						handler = controller[key]
						url = prefix + url

						// before middleware support
						if (controller.before) {
							applet[method](
								url,
								controller.before,
								handler
							)
							if (this.config.debug)
								log(
									"     %s %s -> before -> %s",
									method.toUpperCase(),
									url,
									key
								)
						} else {
							applet[method](url, handler)
							if (this.config.debug)
								log(
									"     %s %s -> %s",
									method.toUpperCase(),
									url,
									key
								)
						}

						// middleware custom routes
						if (!!controller.routes) {
							controller.routes(this)
						}
					}

					// mount the app
					this.app.use(applet)
				}
			)
		}
	}

	/// Adds templating to the app using ejs by default
	templating(supportRendering = true) {
		/// TODO: make this a configurable feature
		this.config.supportRendering = supportRendering

		if (this.config.supportRendering) {
			//Set view engine to ejs
			this.app.set("view engine", "ejs")

			//Tell Express where we keep our index.ejs
			// this.app.set("views", path.join(__dirname, "templates"))

			//Use body-parser
			this.app.use(
				bodyParser.urlencoded({
					extended: false,
				})
			)
		}

		if (!!this.config.subdomains) {
			Object.keys(this.config.subdomains).forEach(
				(subdomain) => {
					if (!!this.config.subdomains[subdomain]) {
						const subdomainTemplate = this.config
							.subdomains[subdomain].template

						if (!!subdomainTemplate) {
							if (debug)
								log({
									templatesFolder: this.config
										.templatesFolder,
									subdomainTemplate,
								})
							const subdomainTemplatePath = path.join(
								this.config.templatesFolder,
								subdomainTemplate
							)

							if (fs.existsSync(subdomainTemplatePath)) {
								log(
									`configuring static path for subdomain: ${subdomain}`,
									subdomainTemplatePath
								)

								this.app.use(
									express.static(subdomainTemplatePath)
								)
							} else {
								log(
									"subdomain template not found", {
										subdomain,
										subdomainTemplatePath,
									}
								)
							}
						} else {
							log("subdomain template not set", {
								subdomain,
							})
						}
					} else {
						log(
							"cannot configure subdomain",
							subdomain
						)
					}
				}
			)
		}

		const baseOverride = path.join(
			this.config.templatesFolder,
			"base"
		)
		log(
			`configuring static path for the base override files`,
			baseOverride
		)
		this.app.use(express.static(baseOverride))

		this.app.use("/public", (req, res) => {
			if (this.config.debug)
				log("asset requested", req.url)
			const file = (req.url =
				req.url.indexOf("?") != -1 ?
				req.url.substring(0, req.url.indexOf("?")) :
				req.url)
			res.sendFile(
				path.join(this.config.publicFolder, req.url)
			)
		})

		log(
			"finished templating set up for path",
			this.config.templatesFolder
		)
	}

	/// Handles OATH requests for authenticating with third-party APIs
	authentication() {
		passport.serializeUser((user, done) => {
			done(null, user)
		})

		passport.deserializeUser((obj, done) => {
			done(null, obj)
		})

		if (this.config.defaults.imgurClientID) {
			log(
				"configuring imgur API authentication for appID:",
				this.config.defaults.imgurClientID
			)

			const setImgurTokens = function (
				accessToken,
				refreshToken,
				profile
			) {
				for (const subdomain of subdomains) {
					authTokens[
						subdomain
					].imgur.imgurAccessToken = accessToken
					authTokens[subdomain].imgur.imgurRefreshToken =
						authTokens[subdomain].imgur.imgurRefreshToken ||
						refreshToken
					authTokens[subdomain].imgur.imgurProfile =
						authTokens[subdomain].imgur.imgurProfile ||
						profile
					log(
						`imgur authentication information for subdomain: subdomain`,
						authTokens[subdomain].imgur
					)
				}
			}

			const imgurStrategy = new ImgurStrategy({
					clientID: this.config.defaults.imgurClientID,
					clientSecret: this.config.defaults
						.imgurClientSecret,
					callbackURL: this.config.defaults
						.imgurCallbackURL,
					passReqToCallback: true,
				},
				(req, accessToken, refreshToken, profile, done) => {
					// if (
					// 	profile.email ==
					// 	this.config.defaults.imgurEmailAddress
					// ) {
					log(
						"imgur auth callback with valid profile",
						profile
					)
					setImgurTokens(
						accessToken,
						refreshToken,
						profile
					)
					return done(null, profile)
					// }
					/// TODO: make this error checking more accurate
					// Someone else wants to authorize our app? Why?
					// console.error(
					// 	"Someone else wants to authorize our app? Why?",
					// 	profile.email,
					// 	this.config.imgurEmailAddress
					// )

					// log('received imgur info', accessToken, refreshToken, profile)
					return done()
				}
			)
			passport.use(imgurStrategy)
			refresh.use(imgurStrategy)

			const imgurRefreshFrequency =
				29 * (1000 * 60 * 60 * 24) // 29 days
			const refreshImgurTokens = function () {
				const theRefreshTokenToUse =
					authTokens.default.imgur.imgurRefreshToken
				log(
					"attempting to refresh imgur access token using the refresh token:",
					theRefreshTokenToUse
				)
				refresh.requestNewAccessToken(
					"imgur",
					theRefreshTokenToUse,
					(err, accessToken, refreshToken) => {
						log(
							"imgur access token has been refreshed:",
							refreshToken
						)
						setImgurTokens(accessToken, refreshToken, null)
					}
				)
			}
			setInterval(refreshImgurTokens, imgurRefreshFrequency)

			// Imgur OAuth2 Integration
			this.app.get(
				"/auth/imgur",
				passport.authenticate("imgur")
			)
			this.app.get(
				"/auth/imgur/callback",
				passport.authenticate("imgur", {
					session: false,
					failureRedirect: "/fail",
					successRedirect: "/",
				})
			)
			this.app.post("/auth/imgur/getToken", (req, res) => {
				const subdomain = getSubdomainPrefix(config, req)
				const response = {
					imgurAlbumHash: this.config.subdomains[subdomain]
						.imgur.imgurAlbumHash,
					imgurAuthorization: this.config.subdomains[
						subdomain
					].imgur.imgurAuthorization,
				}
				log({
					imgurApiResponse: response,
				})

				if (isValidRequestOrigin(this.config, req)) {
					response.imgurRefreshToken =
						authTokens[subdomain].imgur.imgurRefreshToken
					response.imgurAccessToken =
						authTokens[subdomain].imgur.imgurAccessToken
					response.imgurProfile =
						authTokens[subdomain].imgur.imgurProfile
				}

				// This will only return the imgur access token if the request is coming from the site itself
				res.json(response)
			})
		} else {
			this.app.get("/auth/imgur/*", (req, res) => {
				res.send(
					"I don't have imgur data set in my configuration"
				)
			})
			this.app.post("/auth/*", (req, res) => {
				res.json({})
			})
		}

		if (this.config.defaults.redditClientID) {
			log(
				"configuring reddit API authentication for appID:",
				this.config.defaults.redditClientID
			)

			const setRedditTokens = function (
				accessToken,
				refreshToken,
				profile
			) {
				// FOR DOMAIN SPECIFIC USER ACCOUNTS ( DO NOT DELETE )
				// var subdomain = getSubdomainPrefix(config, req)

				// authTokens["imgur"][subdomain].imgurRefreshToken = refreshToken
				// authTokens["imgur"][subdomain].imgurAccessToken = accessToken
				// authTokens["imgur"][subdomain].imgurProfile = profile

				for (const subdomain of subdomains) {
					log(
						"setting reddit authentication information for subdomain:",
						subdomain
					)
					authTokens[
						subdomain
					].reddit.redditAccessToken = accessToken
					authTokens[subdomain].reddit.redditRefreshToken =
						authTokens[subdomain].reddit
						.redditRefreshToken || refreshToken
					authTokens[subdomain].reddit.redditProfile =
						authTokens[subdomain].reddit.redditProfile ||
						profile
					authTokens[subdomain].reddit.redditUserName =
						authTokens[subdomain].reddit.redditUserName ||
						profile.name
				}
			}

			const redditStrategy = new RedditStrategy({
					clientID: this.config.defaults.redditClientID,
					clientSecret: this.config.defaults
						.redditClientSecret,
					callbackURL: this.config.defaults
						.redditCallbackURL,
					passReqToCallback: true,
				},
				(req, accessToken, refreshToken, profile, done) => {
					// if (
					// 	profile.name ==
					// 	this.config.defaults.redditUserName
					// ) {
					log(
						"reddit auth callback with valid profile",
						profile
					)
					setRedditTokens(
						accessToken,
						refreshToken,
						profile
					)

					return done(null, profile)
					// }
					/// TODO: make this error checking more accurate
					// console.error(
					// 	"Someone else wants to authorize our app? Why?",
					// 	profile.name,
					// 	this.config.defaults.redditUserName
					// )
					// Someone else wants to authorize our app? Why?

					// process.nextTick(() => done())
				}
			)

			const redditRefreshFrequency =
				29 * (1000 * 60 * 60 * 24) // 29 days
			const refreshRedditTokens = function () {
				const theRefreshTokenToUse =
					authTokens.default.reddit.redditRefreshToken
				log(
					"attempting to refresh reddit access token using the refresh token:",
					theRefreshTokenToUse
				)
				refresh.requestNewAccessToken(
					"reddit",
					theRefreshTokenToUse,
					(err, accessToken, refreshToken) => {
						log(
							"reddit access token has been refreshed:",
							refreshToken
						)
						setRedditTokens(accessToken, refreshToken, null)
					}
				)
			}
			setInterval(
				refreshRedditTokens,
				redditRefreshFrequency
			)

			passport.use(redditStrategy)
			refresh.use(redditStrategy)

			// Reddit OAuth2 Integration
			this.app.get("/auth/reddit", (req, res, next) => {
				req.session.state = crypto
					.randomBytes(32)
					.toString("hex")
				log("authenticating")
				passport.authenticate("reddit", {
					state: req.session.state,
					duration: "permanent",
				})(req, res, next)
			})
			this.app.get(
				"/auth/reddit/callback",
				(req, res, next) => {
					// Check for origin via state token
					if (req.query.state == req.session.state) {
						// log("passporting")
						passport.authenticate("reddit", {
							successRedirect: "/",
							failureRedirect: "/fail",
						})(req, res, next)
					} else {
						// log("Error 403")
						next(new Error(403))
					}
				}
			)
			this.app.post("/auth/reddit/getToken", (req, res) => {
				const subdomain = getSubdomainPrefix(config, req)
				let tokensValue = "unauthorized access"
				// log("getting token")

				if (isValidRequestOrigin(this.config, req)) {
					// log("request is valid")
					tokensValue = {
						redditRefreshToken: authTokens[subdomain].reddit
							.redditRefreshToken,
						redditAccessToken: authTokens[subdomain].reddit
							.redditAccessToken,
						redditProfile: authTokens[subdomain].reddit.redditProfile,
					}
				}

				// This will only return the reddit access token if the request is coming from the site itself
				res.json({
					redditTokens: tokensValue,
				})
			})
		} else {
			this.app.get("/auth/reddit/*", (req, res) => {
				const responseMessage =
					"I don't have reddit data set in my configuration"
				// log(responseMessage)
				res.send(responseMessage)
			})
			this.app.post("/auth/*", (req, res) => {
				res.json({})
			})
		}
	}

	/// Runs the express (wr)app with all of the middleware configured
	run(
		started = () => {
			log(
				`App listening on: http://${this.config.host}:${this.config.port}`
			)
		}
	) {
		log(`running sexpress on port`, this.config.port)

		this.app.set("port", this.config.port)
		let httpsServer = null,
			serverOpts = {}

		const httpServer = http.createServer(serverOpts, this.app)

		if (!this.config.noSSL && !!this.config.ssl && (!!this.config.ssl.passphrase || !!this.config.ssl.strategy)) {
			try {
				switch (this.config.ssl.strategy) {
					case 'letsencrypt':
						const certDir = "/etc/letsencrypt/live"
						const certDirectoryFiles = fs.readdirSync(certDir)
						const certficates = []

						certDirectoryFiles.forEach((domain) => {
							const domainPath = path.join(certDir, domain)
							const isDirectory = fs.lstatSync(domainPath).isDirectory()

							if (isDirectory) {
								certficates[domain] = {}

								certficates[domain].key = fs.readFileSync(path.join(certDir, domain, 'privkey.pem'))
								certficates[domain].cert = fs.readFileSync(path.join(certDir, domain, 'fullchain.pem'))
							}
						})

						/// TODO: Change this to use as many certs for as many servers as needed
						serverOpts = {
							/// TODO: change this from using the passphrase to domain
							cert: certficates[this.config.ssl.passphrase].cert,
							key: certficates[this.config.ssl.passphrase].key,
						}
						break

					default:
						serverOpts = {
							cert: fs.readFileSync(this.config.ssl.certificateFilename, 'utf-8'),
							key: fs.readFileSync(this.config.ssl.certificateKeyFilename, 'utf-8'),
							// ca: fs.readFileSync(this.config.ssl.certificateAuthorityFilename, 'utf-8'),
							passphrase: this.config.ssl.passphrase,
						}
						break
				}

				log.info(`configuring SSL using certificate information on port:${this.config.sslport}`, serverOpts)
				this.app.set("sslport", this.config.sslport)
				httpsServer = https.createServer(serverOpts, this.app)
			} catch (e) {
				log('error setting up ssl for app', {
					sslSetupError: e
				})
			}
		}

		if (this.config.debug) {
			const reloadServer = reload(this.app)
			const watchPath = getRootPath("templates")

			if (fs.existsSync(watchPath)) {
				watch.watchTree(
					watchPath,
					(f, curr, prev) => {
						log(
							"Asset change detected, reloading connection"
						)
						reloadServer.reload()
					}
				)
			} else {
				log.error('cannot watch because folder does not exist', {
					watchPath
				})
			}
		}

		if (!!httpServer) {
			httpServer.listen(this.app.get("port"), started)
		}

		if (!!httpsServer) {
			httpsServer.listen(this.app.get("sslport"), () => {
				log(
					`App listening on: htts://localhost:${this.config.sslport}`
				)
			})
		}
	}
}

module.exports = Sexpress
