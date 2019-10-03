import resolve from 'rollup-plugin-node-resolve';
import replace from 'rollup-plugin-replace';
import babel from 'rollup-plugin-babel';
import commonjs from 'rollup-plugin-commonjs';
import {terser} from 'rollup-plugin-terser';
import sourcemaps from 'rollup-plugin-sourcemaps';

import packageJson from './package.json';

const targetDir = './dist';

const mode = process.env.NODE_ENV;
const dev = mode === 'development';

export default {
  input: 'src/release.js',
  output: {
    file: `${targetDir}/toolkit-${packageJson.version}.js`,
    format: 'cjs',
  },
  plugins: [
    replace({
      'process.env.NODE_ENV': JSON.stringify(mode),
    }),
    resolve({
      mainFields: ['main'],
    }),
    babel({
      extensions: ['.js'],
      runtimeHelpers: true,
      exclude: ['node_modules/@babel/**'],
      presets: [
        [
          '@babel/preset-env',
          {
            targets: {opera: 64},
            modules: false,
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
    }),
    commonjs(),
    sourcemaps(),
    // !dev &&
    //   terser({
    //     module: true
    //   })
  ],
};
