module.exports = {
  include: ['./node_modules/lazy-module-loader/loader.js', './src/*'],
  presets: [
    [
      '@babel/preset-env',
      {
        targets: {node: true},
      },
    ],
  ],
  plugins: [
    '@babel/plugin-proposal-class-properties',
    '@babel/plugin-syntax-dynamic-import',
    [
      '@babel/plugin-transform-runtime',
      {
        useESModules: true,
      },
    ],
  ],
};
