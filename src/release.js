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

import Toolkit from './core/toolkit';
import nodes, {WebComponent} from './core/nodes';

import Browser from './core/browser';
import Description from './core/description';
import Diff from './core/diff';
import Dispatcher from './core/dispatcher';
import Lifecycle from './core/lifecycle';
import Patch from './core/patch';
import Plugins from './core/plugins';
import Reconciler from './core/reconciler';
import Renderer from './core/renderer';
import Sandbox from './core/sandbox';
import Service from './core/service';
import State from './core/state';
import Reducers from './core/reducers';
import Template from './core/template';
import VirtualDOM from './core/virtual-dom';
import utils from './core/utils';

Object.assign(Toolkit.prototype, nodes, {
  Browser,
  Description,
  Diff,
  Dispatcher,
  Lifecycle,
  Patch,
  Plugins,
  Reconciler,
  Renderer,
  Sandbox,
  Service,
  State,
  Reducers,
  Template,
  VirtualDOM,
  utils,
  noop: () => {},
});

window.opr = window.opr || {};
window.opr.Toolkit = new Toolkit();

module.exports = window.opr.Toolkit;
