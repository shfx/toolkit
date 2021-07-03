console.log('YOLO');

require('@babel/register')({
  presets: [
    [
      '@babel/preset-env',
      {
        targets: {
          node: 'current',
        },
        modules: 'commonjs',
      },
    ],
  ],
  plugins: [
    '@babel/plugin-proposal-class-properties',
    '@babel/plugin-syntax-dynamic-import',
    [
      '@babel/plugin-transform-runtime',
      {
        helpers: false,
        useESModules: true,
      },
    ],
  ],
});

require('dom-test');

global.assert = require('assert');
global.sinon = require('sinon');

{
  const registry = new Map();

  global.loader = {
    get(key) {
      return registry.get(key);
    },
    define(key, module) {
      registry.set(key, module);
    },
    async preload(key) {},
  };

  const Toolkit = require('../../src/release').default;

  Toolkit.assert = (condition, message) => {
    if (!condition) {
      throw new Error(message);
    }
  };

  global.opr = {
    Toolkit,
  };

  Toolkit.configure({
    debug: true,
  });

  global.CustomEvent = class {
    constructor(type, options) {
      this.type = type;
      this.detail = options.detail;
    }
  };

  global.suppressConsoleErrors = () => {
    let consoleError;
    beforeEach(() => {
      consoleError = console.error;
      console.error = () => {};
    });

    afterEach(() => {
      console.error = consoleError;
    });
  };
}

require('./global.js');
