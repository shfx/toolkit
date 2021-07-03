/*
Copyright 2017-2019 Opera Software AS

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import nodes from './nodes';

const isFunction = (target, property) => typeof target[property] === 'function';

const delegated = [
  'commands',
  'constructor',
  'container',
  'dispatch',
  'elementName',
];
const methods = ['connectTo'];
const pluginMethods = [];

const createBoundListener = (listener, component, context) => {
  const boundListener = listener.bind(context);
  boundListener.source = listener;
  boundListener.component = component;
  return boundListener;
};

export default class Sandbox {
  static registerPluginMethod(name) {
    pluginMethods.push(name);
  }

  static create(component) {
    const blacklist = Object.getOwnPropertyNames(nodes.Component.prototype);
    const state = {};
    const autobound = {};
    return new Proxy(component, {
      get: (target, property, receiver) => {
        if (property === 'props') {
          return state.props || target.state || {};
        }
        if (property === 'children') {
          return state.children || [];
        }
        if (property === 'ref') {
          if (target.isRoot()) {
            // returns rendered node instead of custom element for usage of
            // this.ref.querySelector
            return target.content.ref;
          }
          return target.ref;
        }
        if (property === '$component') {
          return component;
        }
        if (delegated.includes(property)) {
          return target[property];
        }
        if (methods.includes(property) && isFunction(target, property)) {
          return createBoundListener(target[property], target, target);
        }
        if (pluginMethods.includes(property)) {
          return target.rootNode[property];
        }
        if (blacklist.includes(property)) {
          return undefined;
        }
        if (isFunction(autobound, property)) {
          return autobound[property];
        }
        if (isFunction(target, property)) {
          return (autobound[property] = createBoundListener(
            target[property],
            target,
            receiver,
          ));
        }
        return target[property];
      },
      set: (target, property, value) => {
        if (property === 'props') {
          state.props = value;
          return true;
        }
        if (property === 'children') {
          state.children = value || [];
          return true;
        }
        return false;
      },
    });
  }
}
