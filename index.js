'use strict'

var path = require('path')
var nativeFs = require('fs')
var cluster = require('cluster')
var exitHook = require('exit-hook')
var EventEmitter = require('events').EventEmitter
var noopFile = path.join(__dirname, 'noop.js')
var PLUGIN_NAME = 'spawn-server-webpack-plugin'
function noop () {}

// Expose plugin.
module.exports = SpawnServerPlugin

/**
 * Creates a webpack plugin that will automatically run the build in a child process.
 *
 * @param {object} [options]
 */
function SpawnServerPlugin (options) {
  this.options = options || {}
  this.triggerRestart = this.emit.bind(this, 'start-new-server')
  this.reload = this.reload.bind(this)
  this.close = this.close.bind(this)
  this.onListening = this.onListening.bind(this)
  this.options.args = this.options.args || []
  this.started = this.listening = false
  this.address = null
  this.devServerConfig = {
    proxy: {
      '**': {
        target: true,
        router: function () {
          return 'http://[::1]:' + this.address.port
        }.bind(this)
      }
    },
    before: function (app) {
      process.env.PORT = 0
      app.use(function (req, res, next) {
        if (this.listening) next()
        else this.once('listening', next)
      }.bind(this))
    }.bind(this)
  }
  exitHook(this.close)
}

SpawnServerPlugin.prototype = Object.create(EventEmitter.prototype)

// Starts plugin.
SpawnServerPlugin.prototype.apply = function (compiler) {
  compiler.hooks.done.tap(PLUGIN_NAME, this.reload)
  compiler.hooks.watchClose.tap(PLUGIN_NAME, this.close)
  compiler.hooks.make.tap(PLUGIN_NAME, function () {
    // Mark the server as not listening while we try to rebuild.
    this.listening = false
  }.bind(this))
  compiler.hooks.watchRun.tap(PLUGIN_NAME, function () {
    // Track watch mode.
    compiler.__IS_WATCHING__ = true
  })
}

// Loads output from memory into a new node process.
SpawnServerPlugin.prototype.reload = function (stats) {
  var compiler = stats.compilation.compiler
  var options = compiler.options
  var fs = compiler.outputFileSystem
  if (!fs.createReadStream) fs = nativeFs

  // Only runs in watch mode.
  if (!compiler.__IS_WATCHING__) return

  // Don't reload if there was errors.
  if (stats.hasErrors()) return

  // Kill existing process.
  this.close(function () {
    // Load script from memory.
    var assets = stats.compilation.assets
    var outFile = path.join(options.output.path, options.output.filename)

    // Update cluster settings to load empty file and use provided args.
    var originalExec = cluster.settings.exec
    var originalArgs = cluster.settings.execArgv
    cluster.settings.exec = noopFile

    // Creates an IIFE that automatically intercepts require calls and uses in memory data.
    cluster.settings.execArgv = this.options.args.concat(
      '-e', 'process.on("message", ' + onServerSpawn.toString() + ')'
    )

    // Start new process.
    this.started = true
    this.worker = cluster.fork()

    // Send compiled javascript to child process.
    this.worker.send({ action: 'spawn', entry: outFile, assets: toSources(assets) })

    if (this.options.waitForAppReady) {
      this.worker.on('message', function checkMessage (data) {
        if (data && data.event === 'app-ready') {
          this.onListening(data.address)
          this.worker.removeListener('message', checkMessage)
        }
      }.bind(this))
    } else {
      // Trigger listening event once any server starts.
      this.worker.once('listening', this.onListening)
    }

    // Reset cluster settings.
    cluster.settings.exec = originalExec
    cluster.settings.execArgv = originalArgs
  }.bind(this))
}

// Kills any running child process.
SpawnServerPlugin.prototype.close = function (done) {
  done = done || noop
  if (!this.started) return done()

  this.listening = false
  this.address = null
  this.emit('closing')

  // Check if we need to close the existing server.
  if (this.worker.isDead()) {
    setImmediate(this.triggerRestart)
  } else {
    process.kill(this.worker.process.pid)
    this.worker.once('exit', this.triggerRestart)
  }

  // Ensure that we only start the most recent router.
  this.removeAllListeners('start-new-server')
  this.once('start-new-server', done)
}

/**
 * Called once the spawned process has a server started/listening.
 * Saves the server address.
 */
SpawnServerPlugin.prototype.onListening = function (address) {
  this.listening = true
  this.address = address
  this.emit('listening')
}

/**
 * Handles the initial load message from the child process server.
 * (Converted to a string above and sent to child process).
 *
 * @param {*} data - the message from the parent process
 */
function onServerSpawn (data) {
  if (!data || data.action !== 'spawn') return

  // Monkey patch asset loading.
  var fs = require('fs')
  var Module = require('module')
  var entry = data.entry
  var assets = data.assets

  // Pretend files from memory exist on disc.
  var findPath = Module._findPath
  Module._findPath = function (file) {
    return (assets[file] && file) || findPath.apply(this, arguments)
  }

  // Patches target 'node' System.import calls.
  var readFileSync = fs.readFileSync
  fs.readFileSync = function (file) {
    return assets[file] || readFileSync.apply(this, arguments)
  }

  // Allows for source-map-support.
  var existsSync = fs.existsSync
  fs.existsSync = function (file) {
    return (file in assets) || existsSync.apply(this, arguments)
  }

  // Patches target 'async-node' System.import calls.
  var readFile = fs.readFile
  fs.readFile = function (file) {
    if (!assets[file]) return readFile.apply(this, arguments)
    var cb = arguments[arguments.length - 1]
    setImmediate(function () { cb(null, assets[file]) })
  }

  // Load entry file from assets.
  require(entry)
}

/**
 * Converts webpack assets into a searchable map.
 */
function toSources (assets) {
  var result = {}
  var asset

  for (var key in assets) {
    asset = assets[key]
    result[asset.existsAt] = asset.source()
  }

  return result
}
