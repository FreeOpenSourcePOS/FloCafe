'use strict';

const Module = require('node:module');
const path = require('node:path');

if (!process.env.TSX_TSCONFIG_PATH) {
  process.env.TSX_TSCONFIG_PATH = path.resolve(__dirname, 'tsconfig.json');
}

const originalCompile = Module.prototype._compile;

// Preserve tsc CommonJS export mutability for TypeScript modules transpiled by
// tsx/esbuild so existing test suites that stub `mod.exportedFn = ...` behave
// identically to `tsc` output.
Module.prototype._compile = function compileWithMutableExports(content, filename) {
  if (
    typeof filename !== 'string' ||
    filename.includes('/node_modules/') ||
    filename.includes('\\node_modules\\') ||
    !/\.[cm]?tsx?$/.test(filename)
  ) {
    return originalCompile.call(this, content, filename);
  }

  let currentExports = this.exports;
  Object.defineProperty(this, 'exports', {
    configurable: true,
    enumerable: true,
    get() {
      return currentExports;
    },
    set(next) {
      if (
        next &&
        typeof next === 'object' &&
        Object.prototype.hasOwnProperty.call(next, '__esModule')
      ) {
        const mutable = Object.create(Object.getPrototypeOf(next));
        for (const key of Reflect.ownKeys(next)) {
          const desc = Object.getOwnPropertyDescriptor(next, key);
          if (!desc) continue;
          if (desc.get && !desc.set && !desc.configurable) {
            const getter = desc.get;
            Object.defineProperty(mutable, key, {
              enumerable: desc.enumerable,
              configurable: true,
              get: getter,
              set(value) {
                Object.defineProperty(mutable, key, {
                  value,
                  writable: true,
                  enumerable: desc.enumerable,
                  configurable: true,
                });
              },
            });
          } else {
            Object.defineProperty(mutable, key, desc);
          }
        }
        currentExports = mutable;
      } else {
        currentExports = next;
      }
    },
  });

  try {
    return originalCompile.call(this, content, filename);
  } finally {
    Object.defineProperty(this, 'exports', {
      value: currentExports,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
};

require('tsx/cjs');
