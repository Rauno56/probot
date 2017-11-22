const sentryStream = require('bunyan-sentry-stream')
const cacheManager = require('cache-manager')
const Webhooks = require('@octokit/webhooks')
const Raven = require('raven')

const createApp = require('./github-app')
const createRobot = require('./robot')
const createServer = require('./server')
const resolve = require('./resolver')
const logger = require('./logger')

const cache = cacheManager.caching({
  store: 'memory',
  ttl: 60 * 60 // 1 hour
})

const defaultApps = [
  require('./plugins/stats'),
  require('./plugins/default')
]

module.exports = (options = {}) => {
  const webhook = new Webhooks({path: options.webhookPath || '/', secret: options.secret || 'development'})
  const app = createApp({
    id: options.id,
    cert: options.cert,
    debug: process.env.LOG_LEVEL === 'trace'
  })
  const server = createServer(webhook.middleware)

  // Log all received webhooks
  webhook.on('*', event => {
    logger.trace(event, 'webhook received')
    receive(event)
  })

  // Log all webhook errors
  webhook.on('error', logger.error.bind(logger))

  // If sentry is configured, report all logged errors
  if (process.env.SENTRY_DSN) {
    Raven.disableConsoleAlerts()
    Raven.config(process.env.SENTRY_DSN, {
      autoBreadcrumbs: true
    }).install({})

    logger.addStream(sentryStream(Raven))
  }

  const robots = []

  function receive (event) {
    if (event.event) {
      console.log('DEPRECATED: robot.receive({event, payload}) is now robot.receive({name, payload})')
      event.name = event.event
    }

    return Promise.all(robots.map(robot => robot.receive(event)))
  }

  function load (plugin) {
    if (typeof plugin === 'string') {
      plugin = resolve(plugin)
    }

    const robot = createRobot({app, cache, logger, catchErrors: true})

    // Connect the router from the robot to the server
    server.use(robot.router)

    // Initialize the plugin
    plugin(robot)
    robots.push(robot)

    return robot
  }

  function setup (apps) {
    // Log all unhandled rejections
    process.on('unhandledRejection', logger.error.bind(logger))

    // Load the given apps along with the default apps
    apps.concat(defaultApps).forEach(app => load(app))
  }

  return {
    server,
    webhook,
    receive,
    logger,
    load,
    setup,

    start () {
      server.listen(options.port)
      logger.trace('Listening on http://localhost:' + options.port)
    }
  }
}

module.exports.createRobot = createRobot
