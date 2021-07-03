import resolve from 'rollup-plugin-node-resolve';
import replace from 'rollup-plugin-replace';
import babel from 'rollup-plugin-babel';
import commonjs from 'rollup-plugin-commonjs';
import {terser} from 'rollup-plugin-terser';
import sourcemaps from 'rollup-plugin-sourcemaps';

import packageJson from './package.json';

const targetDir = './dist';

const mode = process.env.NODE_ENV;
const dev = mode !== 'production';

export default {
  input: 'src/release.js',
  output: {
    sourcemap: dev,
    file: `${targetDir}/toolkit-${packageJson.version}.js`,
    format: 'umd',
    name: 'opr.Toolkit',
  },
  plugins: [
    replace({
      'process.browser': true,
      'process.platform': JSON.stringify(process.platform),
      'process.env.NODE_ENV': JSON.stringify(mode),
    }),
    resolve({
      preferBuiltins: false,
      browser: true,
    }),
    babel({
      extensions: ['.js'],
      runtimeHelpers: true,
      exclude: ['node_modules/@babel/**'],
    }),
    commonjs(),
    sourcemaps(),
    !dev &&
      terser({
        module: true,
      }),
  ],
};
