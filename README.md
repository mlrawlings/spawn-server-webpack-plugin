# Spawn Server (Webpack Plugin)
Webpack plugin for Node builds that will automatically load the build into memory when watching and restart the server on consecutive builds.

# Installation

#### Npm
```console
npm install spawn-server-webpack-plugin
```

# Example Config
```javascript
var webpack = require('webpack')
var SpawnServerPlugin = require('spawn-server-webpack-plugin')
var spawnedServer = new SpawnServerPlugin({
  args: [
    '--inspect-brk',
    '-r', 'some-file.js'
  ]
})

// Build webpack config.
var config = {
  name: 'Server',
  target: 'node',
  devtool: 'cheap-module-inline-source-map',
  externals: [/^[^./!]/], // Trick to exclude node modules.
  entry: './myfile.js',
  plugins: [
    // Support inline sourcemaps.
    new webpack.BannerPlugin({ banner: 'require("source-map-support").install({ hookRequire: true })', raw: true }),
    // Use the plugin.
    spawnedServer
  ],
  output: {
    libraryTarget: 'commonjs2',
    filename: 'build.js',
    path: 'dist'
  }
}

// Start webpack and trigger watch mode.
webpack(config).watch({ ignore: /node_modules/ }, function (err, stats) {
  // The built node server will start running in the background.
})

// Special events (listening and closing)
spawnedServer.on('listening', function (address) {
  this.address === { port: ..., ip: ... }
  this.listening === true
})

spawnedServer.on('closing', function () {
  this.address === null
  this.listening === false
})
```

### Using with webpack-dev-server

To automatically proxy a WebpackDevServer to the active spawned server (and to ensure that requests wait during server rebuilds) you can add the config exposed under `spawnedServerInstance.devServerConfig` into your `devServer` webpack options.

```js
const configs = [
  {...}, // Browser build
  {...} // Server build (included spawn-server-plugin)
]

new DevServer(webpack(configs), {
  // Set your custom options, then spread in the spawned server config
  ...spawnedServer.devServerConfig
}).listen(8081)

// This is approximately the same as:

new DevServer(webpack(configs), {
  ...,
  // Setup proxy to the actual server.
  proxy: { '**': { target: 'http://localhost:8080' } },
  // Ensure webpack waits for server build before reloading.
  setup (app) {
    app.use((req, res, next) => {
      if (spawnedServer.listening) next()
      else spawnedServer.once('listening', next)
    })
  }
}).listen(8081)
```

You can also add this configuration in the same way into the `webpack.config.js` file under the `devServer` option.

#### Dynamic Server Port
Using the `devServerConfig` will automatically set `process.env.PORT = 0`. This allows for the spawned server to start on the next available port if you use this environment variable as the port option when listening.

#### Process with multiple servers
By default this plugin will wait for the first http server to be listening and make that information available as the `address`. You can optionally provide a `waitForAppReady: true` option when instanciating the plugin and use `process.send({ event: "app-ready", address: server.address() })` within your process to signal which server should be referenced.

### Contributions

* Use `npm test` to run tests.

Please feel free to create a PR!
