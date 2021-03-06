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

window.loadToolkit = async configureLoader => {

  if (configureLoader) {
    configureLoader();
  }

  const Toolkit = await loader.require('core/toolkit');
  const nodes = await loader.require('core/nodes');

  Object.assign(Toolkit.prototype, nodes, {
    Browser: await loader.require('core/browser'),
    Description: await loader.require('core/description'),
    Diff: await loader.require('core/diff'),
    Dispatcher: await loader.require('core/dispatcher'),
    Lifecycle: await loader.require('core/lifecycle'),
    Patch: await loader.require('core/patch'),
    Plugins: await loader.require('core/plugins'),
    Reconciler: await loader.require('core/reconciler'),
    Reducers: await loader.require('core/reducers'),
    Renderer: await loader.require('core/renderer'),
    Sandbox: await loader.require('core/sandbox'),
    Service: await loader.require('core/service'),
    State: await loader.require('core/state'),
    Template: await loader.require('core/template'),
    VirtualDOM: await loader.require('core/virtual-dom'),
    utils: await loader.require('core/utils'),
    noop: () => {},
  });

  window.opr = window.opr || {};
  window.opr.Toolkit = new Toolkit();
};
