/*
Copyright 2017-2018 Opera Software AS

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

{
  const isBrowser = 'object' === typeof window;
  const $global = isBrowser ? window : global;

  class Module {

    constructor(id, isRequired) {
      this.id = id;
      this.isRequired = isRequired;

      this.exports = null;
      this.dependencies = new Set();
      this.clients = new Set();
    }

    /*
     * Returns a set of all module's dependencies.
     */
    get deepDependencies() {
      const deps = new Set();
      const collect = module => {
        for (const dependency of module.dependencies) {
          if (!deps.has(dependency)) {
            deps.add(dependency);
            collect(dependency);
          }
        }
      };
      collect(this);
      return deps;
    }
  }

  class Context {

    constructor() {
      this.stack = [];
    }

    /*
     * Pushes the module onto the stack.
     */
    save(module) {
      this.stack.push(module);
    }

    /*
     * Restores the stack to the previous state.
     */
    restore(module) {
      const lastModule = this.stack.pop();
      if (lastModule !== module) {
        throw new Error(
            `Invalid context detected: '${
                                          lastModule.id
                                        }', expecting: ${module.id}`);
      }
    }

    /*
     * Returns the last module from the stack.
     */
    get module() {
      return this.stack[this.stack.length - 1] || null;
    }

    /*
     * Adds the specified dependency to the current module.
     */
    registerDependencyTo(dependency, required = false) {
      if (this.module) {
        this.module.dependencies.add(dependency);
        dependency.clients.add(this.module);
      }
    }
  }

  /* Mapping of ids to promises of exported values. */
  const exportPromises = new Map();

  /* Mapping of ids to promises of loaded modules. */
  const loadPromises = new Map();

  class Loader {

    constructor() {
      this.ready = Promise.resolve(null);
      this.context = new Context();
      this.registry = new Map();
    }

    /*
     * Makes the loader use the specified plugin.
     */
    use(plugin) {
      console.assert(
          plugin.constructor === Object, 'Plugin must be a plain object!');
      Object.setPrototypeOf(plugin, loader);
      return $global.loader = plugin;
    }

    /*
     * Declares that module resolved by given id
     * is an optional dependency.
     *
     * Returns a symbol for the specified id.
     */
    symbol(id) {
      let module = this.registry.get(id);
      if (!module) {
        module = this.registerModule(id);
      }
      this.context.registerDependencyTo(module);
      return Symbol.for(id);
    }

    /*
     * Finds a module by the specified id and declares it
     * to be a required dependency.
     *
     * Returns module's exported value.
     */
    async require(id) {
      let module = this.registry.get(id);
      if (module) {
        if (!module.isRequired) {
          module.isRequired = true;
        }
      } else {
        module = this.registerModule(id, true);
      }
      this.context.registerDependencyTo(module);
      return await this.resolve(id);
    }

    /*
     * Finds a module by the specified id.
     *
     * Returns module's exported value.
     */
    async resolve(id) {
      let module = this.registry.get(id);
      if (module) {
        if (module.exports) {
          return module.exports;
        }
        if (module.isPending) {
          return exportPromises.get(id);
        }
      } else {
        module = this.registerModule(id);
      }
      return await this.load(module);
    }

    /*
     * Defines the exported value for the module with the specified id.
     * If the module does not exist, creates a new one.
     */
    define(id, exported) {
      const module = this.registry.get(id) || this.registerModule(id);
      if (!module.exports) {
        module.exports = exported;
        this.registry.set(id, module);
      }
      return module;
    }

    /*
     * Gets the module from the cache and returns its exported value.
     * Returns null if the module is not found.
     */
    get(id) {
      const module = this.registry.get(id);
      return module ? module.exports : null;
    }

    /*
     * Preloads the module with given id and preloads recursively
     * all the dependencies. Returns module's exported value.
     */
    async preload(id) {

      let loadPromise = loadPromises.get(id);
      if (loadPromise) {
        return loadPromise;
      }

      const done = await this.waitForLoader();

      const module = this.registry.get(id);
      if (module && module.isLoaded) {
        return module.exports;
      }

      loadPromise = this.loadWithDependencies(id);
      loadPromises.set(id, loadPromise);

      const exported = await loadPromise;
      done();
      return exported;
    }

    /*
     * Waits for the loader to be ready.
     * Returns the "done" function to release loader for the subsequent calls.
     */
    async waitForLoader() {
      const loaderReady = this.ready;
      let done;
      const donePromise = new Promise(resolve => {
        done = resolve;
      });
      this.ready = donePromise;

      await loaderReady;
      return done;
    }

    /*
     * Loads the module with given id with all its dependencies.
     * Returns module's exported value.
     */
    async loadWithDependencies(id) {
      const exported = await this.resolve(id);
      const module = this.registry.get(id);
      for (const dependency of module.dependencies) {
        if (!dependency.exports) {
          await this.loadWithDependencies(dependency.id);
        }
      }
      module.isLoaded = true;
      return exported;
    }

    /*
     * Loads and initializes the module. Returns its exported value.
     */
    async load(module) {

      const id = module.id;
      const path = this.path(id);

      try {

        this.context.save(module);

        module.isPending = true;

        const exportPromise =
            isBrowser ? this.loadInBrowser(path) : this.loadInNode(path);
        exportPromises.set(id, exportPromise);

        const exported = await exportPromise;
        delete module.isPending;

        if (!exported) {
          throw new Error(`No "module.exports" found in module with id: ${id}`);
        }
        module.exports = exported;

        if (typeof module.exports.init === 'function') {
          await module.exports.init();
        }

        this.context.restore(module);

        return exported;

      } catch (error) {
        this.report({
          id,
          error,
        });
        failed(error);
      }
    }

    /*
     * Returns the resource path for the specified id.
     */
    path(id) {
      if (id.endsWith('/')) {
        return `${id}main.js`;
      }
      if (/^(.*)\.([a-z0-9]{1,4})$/.test(id)) {
        return id;
      }
      return `${id}.js`;
    }

    /*
     * Loads the script in the browser environment.
     */
    loadInBrowser(path) {
      return new Promise((resolve, reject) => {
        window.module = {
          exports: null,
        };
        const script = document.createElement('script');
        script.src = path;
        script.onload = () => {
          const exported = module.exports;
          delete window.module;
          resolve(exported);
        };
        script.onerror = error => {
          reject(error);
        };
        document.head.appendChild(script);
      });
    }

    /*
     * Loads the script in the node.js environment.
     */
    loadInNode(path) {
      if ($global.decache) {
        decache(path);
      }
      return require(path);
    }

    /*
     * Reports the error provided by the error message.
     */
    report(message) {
      console.error('Error loading module:', message.id);
      throw message.error;
    }

    /*
     * Creates an instance of a module with given id and registers it.
     */
    registerModule(id, isRequired = false) {
      const module = new Module(id, isRequired);
      this.registry.set(id, module);
      return module;
    }

    /*
     * Resets loader state.
     */
    reset() {
      this.ready = Promise.resolve(null);
      this.registry.clear();
      exportPromises.clear();
      loadPromises.clear();
    }
  }

  $global.loader = new Loader();
}

{
  const SUPPORTED_EVENTS = [
    // mouse events
    'onAuxClick',
    'onClick',
    'onContextMenu',
    'onDoubleClick',
    'onDrag',
    'onDragEnd',
    'onDragEnter',
    'onDragExit',
    'onDragLeave',
    'onDragOver',
    'onDragStart',
    'onDrop',
    'onMouseDown',
    'onMouseEnter',
    'onMouseLeave',
    'onMouseMove',
    'onMouseOut',
    'onMouseOver',
    'onMouseUp',
    // keyboard events
    'onKeyDown',
    'onKeyPress',
    'onKeyUp',
    // focus events
    'onFocus',
    'onBlur',
    // form events
    'onChange',
    'onInput',
    'onInvalid',
    'onSubmit',
    // clipboard events
    'onCopy',
    'onCut',
    'onPaste',
    // composition events
    'onCompositionEnd',
    'onCompositionStart',
    'onCompositionUpdate',
    // selection events
    'onSelect',
    // touch events
    'onTouchCancel',
    'onTouchEnd',
    'onTouchMove',
    'onTouchStart',
    // UI events
    'onScroll',
    // wheel events
    'onWheel',
    // media events
    'onAbort',
    'onCanPlay',
    'onCanPlayThrough',
    'onDurationChange',
    'onEmptied',
    'onEncrypted',
    'onEnded',
    'onError',
    'onLoadedData',
    'onLoadedMetadata',
    'onLoadStart',
    'onPause',
    'onPlay',
    'onPlaying',
    'onProgress',
    'onRateChange',
    'onSeeked',
    'onSeeking',
    'onStalled',
    'onSuspend',
    'onTimeUpdate',
    'onVolumeChange',
    'onWaiting',
    // image events
    'onLoad',
    'onError',
    // animation events
    'onAnimationStart',
    'onAnimationEnd',
    'onAnimationIteration',
    // transition events
    'onTransitionEnd',
    // search event
    'onSearch',
    // toogle event
    'onToggle',
  ];

  const SUPPORTED_ATTRIBUTES = [
    // most used attributes
    'tabIndex',
    'href',
    'draggable',
    'name',
    'disabled',
    'type',
    'value',
    'id',
    'checked',
    'contentEditable',
    'readOnly',
    'alt',
    'title',
    'width',
    'height',
    'required',
    'for',
    'label',
    'minLength',
    'maxLength',
    'method',
    'src',
    'rel',

    // other attributes
    'accept',
    'acceptCharset',
    'accessKey',
    'action',
    'allowFullScreen',
    'allowTransparency',
    'async',
    'autoComplete',
    'autoFocus',
    'autoPlay',
    'capture',
    'cellPadding',
    'cellSpacing',
    'challenge',
    'charSet',
    'cite',
    'classID',
    'colSpan',
    'cols',
    'content',
    'contextMenu',
    'controls',
    'coords',
    'crossOrigin',
    'data',
    'dateTime',
    'default',
    'defer',
    'dir',
    'download',
    'encType',
    'form',
    'frameBorder',
    'headers',
    'hidden',
    'high',
    'hrefLang',
    'httpEquiv',
    'icon',
    'incremental',
    'inputMode',
    'integrity',
    'is',
    'keyParams',
    'keyType',
    'kind',
    'lang',
    'list',
    'loop',
    'low',
    'manifest',
    'marginHeight',
    'marginWidth',
    'max',
    'media',
    'mediaGroup',
    'min',
    'multiple',
    'muted',
    'noValidate',
    'nonce',
    'open',
    'optimum',
    'pattern',
    'placeholder',
    'poster',
    'preload',
    'profile',
    'radioGroup',
    'reversed',
    'role',
    'rowSpan',
    'rows',
    'sandbox',
    'scope',
    'scoped',
    'scrolling',
    'seamless',
    'selected',
    'shape',
    'size',
    'sizes',
    'span',
    'spellCheck',
    'srcDoc',
    'srcLang',
    'srcSet',
    'start',
    'step',
    'summary',
    'target',
    'useMap',
    'wmode',
    'wrap',

    // aria attributes
    'ariaActiveDescendant',
    'ariaAtomic',
    'ariaAutoComplete',
    'ariaBusy',
    'ariaChecked',
    'ariaControls',
    'ariaDescribedBy',
    'ariaDisabled',
    'ariaDropEffect',
    'ariaExpanded',
    'ariaFlowTo',
    'ariaGrabbed',
    'ariaHasPopup',
    'ariaHidden',
    'ariaInvalid',
    'ariaLabel',
    'ariaLabelLedBy',
    'ariaLevel',
    'ariaLive',
    'ariaMultiLine',
    'ariaMultiSelectable',
    'ariaOrientation',
    'ariaOwns',
    'ariaPosInSet',
    'ariaPressed',
    'ariaReadOnly',
    'ariaRelevant',
    'ariaRequired',
    'ariaSelected',
    'ariaSetSize',
    'ariaSort',
    'ariaValueMax',
    'ariaValueMin',
    'ariaValueNow',
    'ariaValueText',
  ];

  const getSupportedStyles = element => {
    const keys = Object.keys(element.style);
    if (keys.length) {
      return keys;
    }
    return Object.keys(Object.getPrototypeOf(element.style))
        .filter(key => !key.includes('-'));
  };

  const SUPPORTED_STYLES = getSupportedStyles(document.documentElement);

  const SUPPORTED_FILTERS = [
    'blur',
    'brightness',
    'contrast',
    'dropShadow',
    'grayscale',
    'hueRotate',
    'invert',
    'opacity',
    'sepia',
    'saturate',
  ];

  const SUPPORTED_TRANSFORMS = [
    'matrix',
    'matrix3d',
    'translate',
    'translate3d',
    'translateX',
    'translateY',
    'translateZ',
    'scale',
    'scale3d',
    'scaleX',
    'scaleY',
    'scaleZ',
    'rotate',
    'rotate3d',
    'rotateX',
    'rotateY',
    'rotateZ',
    'skew',
    'skewX',
    'skewY',
    'perspective',
  ];

  const Consts = {
    SUPPORTED_ATTRIBUTES,
    SUPPORTED_EVENTS,
    SUPPORTED_STYLES,
    SUPPORTED_FILTERS,
    SUPPORTED_TRANSFORMS,
  };

  loader.define('core/consts', Consts);
}

{
  class VirtualNode {

    constructor(key, parentNode = null) {
      this.key = key;
      this.parentNode = parentNode;
    }

    get parentElement() {
      if (this.parentNode) {
        return this.parentNode.isElement() ? this.parentNode :
                                             this.parentNode.parentElement;
      }
      return null;
    }

    get container() {
      if (this.parentNode) {
        return this.parentNode.container;
      }
      return this;
    }

    get rootNode() {
      if (this.isRoot()) {
        return this;
      }
      if (this.parentNode) {
        return this.parentNode.rootNode;
      }
      throw new Error('Inconsistent virtual DOM tree detected!');
    }

    isRoot() {
      return this instanceof Root;
    }

    isComponent() {
      return this instanceof Component;
    }

    isElement() {
      return this instanceof VirtualElement;
    }

    isComment() {
      return this instanceof Comment;
    }

    isCompatible(node) {
      return node && this.nodeType === node.nodeType && this.key === node.key;
    }
  }

  class Component extends VirtualNode {

    static get NodeType() {
      return 'component';
    }

    constructor(description, parentNode, attachDOM = true) {
      super(description.key, parentNode);
      this.description = description;

      this.sandbox = opr.Toolkit.Sandbox.create(this);

      this.comment = this.createComment();
      this.child = null;

      this.cleanUpTasks = [];
      if (attachDOM) {
        this.attachDOM();
      }
    }

    createComment() {
      return new Comment(` ${this.constructor.name} `, this);
    }

    hasOwnMethod(method) {
      return this.constructor.prototype.hasOwnProperty(method);
    }

    connectTo(service, listeners) {
      opr.Toolkit.assert(
          service.connect instanceof Function,
          'Services have to define the connect() method');
      const disconnect = service.connect(listeners);
      opr.Toolkit.assert(
          disconnect instanceof Function,
          'The result of the connect() method has to be a disconnect() method');
      disconnect.service = service;
      this.cleanUpTasks.push(disconnect);
    }

    appendChild(child) {
      this.child = child;
      this.child.parentNode = this;
      this.comment.parentNode = null;
      this.comment = null;
    }

    removeChild(child) {
      opr.Toolkit.assert(
          this.child === child, 'Specified node is not a child of this node');
      this.child.parentNode = null;
      this.child = null;
      this.comment = this.createComment();
    }

    replaceChild(child, node) {
      opr.Toolkit.assert(
          this.child === child, 'Specified node is not a child of this node');
      this.child.parentNode = null;
      this.child = node;
      this.child.parentNode = this;
    }

    get childElement() {
      if (this.child) {
        if (this.child.isElement() || this.child.isRoot()) {
          return this.child;
        }
        if (this.child.isComponent()) {
          return this.child.childElement;
        }
      }
      return null;
    }

    get placeholder() {
      if (this.comment) {
        return this.comment;
      }
      if (this.child && this.child.isComponent()) {
        return this.child.placeholder;
      }
      return null;
    }

    render() {
      return undefined;
    }

    get commands() {
      return this.rootNode.commands;
    }

    destroy() {
      for (const cleanUpTask of this.cleanUpTasks) {
        cleanUpTask();
      }
    }

    broadcast(name, data) {
      this.container.dispatchEvent(new CustomEvent(name, {
        detail: data,
        bubbles: true,
        composed: true,
      }))
    }

    preventDefault(event) {
      event.preventDefault();
    }

    stopEvent(event) {
      event.stopImmediatePropagation();
      event.preventDefault();
    }

    get nodeType() {
      return Component.NodeType;
    }

    get ref() {
      return this.renderedNode;
    }

    get renderedNode() {
      return this.childElement ? this.childElement.ref : this.placeholder.ref;
    }

    isCompatible(node) {
      return super.isCompatible(node) && this.constructor === node.constructor;
    }

    attachDOM() {
      if (this.child) {
        this.child.attachDOM();
      } else {
        this.comment.attachDOM();
      }
    }

    detachDOM() {
      if (this.child) {
        this.child.detachDOM();
      } else {
        this.comment.detachDOM();
      }
    }
  }

  const CONTAINER = Symbol('container');
  const CUSTOM_ELEMENT = Symbol('custom-element');
  const COMMANDS = Symbol('commands');

  class Root extends Component {

    static get NodeType() {
      return 'root';
    }

    static get displayName() {
      return this.name;
    }

    static get styles() {
      return [];
    }

    constructor(description, props, originator = null) {
      super(description, /*= parentNode */ null, false);
      this.props = props;
      if (originator === null) {
        throw new Error('No originator specified for rendered root component');
      }
      this.originator = originator;
      this.plugins = this.createPlugins();
      this.subroots = new Set();
      this.renderer = new opr.Toolkit.Renderer(this);
      this.state = null;
      this.reducer = opr.Toolkit.utils.combineReducers(...this.getReducers());
      this.dispatch = command => {
        const prevState = this.state;
        const nextState = this.reducer(prevState, command);
        this.renderer.updateDOM(command, prevState, nextState);
      };
      this.commands = this.createCommandsDispatcher();
      this.ready = new Promise(resolve => {
        this.markAsReady = resolve;
      });
      this.attachDOM();
    }

    normalize(state) {
      return opr.Toolkit.Template.normalizeComponentProps(
          state, this.constructor);
    }

    /*
     * Triggers the initial rendering of the component in given container.
     */
    async init(container) {
      this.container = container;
      await this.plugins.installAll();
      this.originator.track(this);

      const state =
          await this.getInitialState.call(this.sandbox, this.props);
      if (state.constructor !== Object) {
        throw new Error('Initial state must be a plain object!');
      }

      this.commands.init(this.normalize(state));
      this.markAsReady();
    }

    /*
     * The default implementation of the method returning
     * the props passed from the parent.
     */
    async getInitialState(props = {}) {
      return props;
    }

    /*
     * Triggers the component update.
     */
    update(description) {
      const state =
          this.getUpdatedState(description.props, this.description.props);
      if (state.constructor !== Object) {
        throw new Error('Updated state must be a plain object!');
      }
      this.commands.update(this.normalize(state));
    }

    /*
     * The default implementation of the method returning
     * the current state with overrides by the props passed from the parent.
     */
    getUpdatedState(props = {}, state = {}) {
      return {
        ...state,
        ...props,
      };
    }

    set commands(commands) {
      this[COMMANDS] = commands;
    }

    get commands() {
      return this[COMMANDS];
    }

    track(root) {
      this.subroots.add(root);
    }

    stopTracking(root) {
      this.subroots.delete(root);
    }

    get tracked() {
      const tracked = [];
      for (const root of this.subroots) {
        tracked.push(root, ...root.tracked);
      }
      return tracked;
    }

    createCommandsDispatcher() {
      const dispatcher = {};
      for (const key of Object.keys(this.reducer.commands)) {
        dispatcher[key] = (...args) => {
          if (this.dispatch) {
            this.dispatch(this.reducer.commands[key](...args));
          }
        };
      }
      return dispatcher;
    }

    createPlugins(toolkit) {
      const plugins = new opr.Toolkit.Plugins(this);
      for (const plugin of this.originator.plugins) {
        plugins.register(plugin);
      }
      return plugins;
    }

    addPluginsAPI(element) {
      const {
        Plugin,
      } = opr.Toolkit.Plugins;
      element.install = (plugin, cascade = true) => {
        const installTo = root => {
          if (plugin instanceof Plugin) {
            root.plugins.use(plugin);
          } else {
            root.plugins.install(plugin);
          }
          if (cascade) {
            for (const subroot of root.subroots) {
              installTo(subroot);
            }
          }
        };
        installTo(this);
      };
      element.uninstall = (plugin, cascade = true) => {
        const name = typeof plugin === 'string' ? plugin : plugin.name;
        const uninstallFrom = root => {
          root.plugins.uninstall(name);
          if (cascade) {
            for (const subroot of root.subroots) {
              uninstallFrom(subroot);
            }
          }
        };
        uninstallFrom(this);
      };
    }

    async mount(container) {
      this.attachDOM();
      if (this.constructor.elementName) {
        // triggers this.init() from element's connected callback
        container.appendChild(this.ref);
      } else {
        await this.init(container);
      }
    }

    attachDOM() {
      if (this.constructor.elementName) {
        this.ref = this.createCustomElement();
      } else {
        super.attachDOM();
      }
    }

    createCustomElement(toolkit) {
      const defineCustomElementClass = RootClass => {
        let ElementClass = customElements.get(RootClass.elementName);
        if (!ElementClass) {
          ElementClass = class RootElement extends ComponentElement {};
          customElements.define(RootClass.elementName, ElementClass);
          RootClass.prototype.elementClass = ElementClass;
        }
        return ElementClass;
      };
      const ElementClass = defineCustomElementClass(this.constructor);
      const customElement = new ElementClass(this, this.toolkit);
      this.addPluginsAPI(customElement);
      return customElement;
    }

    getStylesheets() {
      const stylesheets = [];
      const stylesheetProviders =
          [...this.plugins].filter(plugin => plugin.isStylesheetProvider());
      for (const plugin of stylesheetProviders) {
        if (typeof plugin.getStylesheets !== 'function') {
          throw new Error(
              `Plugin '${
                         plugin.name
                       }' must provide the getStylesheets() method!`);
        }
        stylesheets.push(...plugin.getStylesheets());
      }
      if (Array.isArray(this.constructor.styles)) {
        stylesheets.push(...this.constructor.styles);
      }
      return stylesheets;
    }

    get ref() {
      return this[CUSTOM_ELEMENT] || super.renderedNode;
    }

    set ref(ref) {
      this[CUSTOM_ELEMENT] = ref;
    }

    set container(container) {
      this[CONTAINER] = container;
    }

    get container() {
      return this[CONTAINER];
    }

    get toolkit() {
      return this.originator.toolkit || this.originator;
    }

    getReducers() {
      return [];
    }

    destroy() {
      super.destroy();
      this.originator.stopTracking(this);
      this.renderer.destroy();
      this.renderer = null;
      this.plugins.destroy();
      this.plugins = null;
      this.reducer = null;
      this.dispatch = null;
      this.originator = null;
    }

    get nodeType() {
      return Root.NodeType;
    }
  }

  const cssImports = paths =>
      paths.map(loader.path).map(path => `@import url(${path});`).join('\n');

  class ComponentElement extends HTMLElement {

    constructor(root) {

      super();
      this.$root = root;

      const shadow = this.attachShadow({
        mode: 'open',
      });
      const slot = document.createElement('slot');

      const stylesheets = root.getStylesheets();

      if (stylesheets && stylesheets.length) {

        const style = document.createElement('style');
        style.textContent = cssImports(stylesheets);

        style.onload = () => root.init(slot);
        style.onerror = () => {
          throw new Error(
              `Error loading stylesheets: ${stylesheets.join(', ')}`);
        };
        shadow.appendChild(style);
        shadow.appendChild(slot);
      } else {
        shadow.appendChild(slot);
        root.init(slot);
      }
    }

    get isComponentElement() {
      return true;
    }

    connectedCallback() {
      clearTimeout(this.pendingDestruction);
    }

    disconnectedCallback() {
      this.pendingDestruction = setTimeout(() => this.destroy(), 50);
    }

    destroy() {
      const Lifecycle = opr.Toolkit.Lifecycle;
      const root = this.$root;
      Lifecycle.onComponentDestroyed(root);
      Lifecycle.onComponentDetached(root);
      root.ref = null;
      this.$root = null;
    }
  }

  class VirtualElement extends VirtualNode {

    static get NodeType() {
      return 'element';
    }

    constructor(description, parentNode) {
      super(description.key || null, parentNode);
      this.description = description;
      if (description.children) {
        this.children = description.children.map(
            childDescription => opr.Toolkit.VirtualDOM.createFromDescription(
                childDescription, this));
      }
      this.attachDOM();
    }

    setAttribute(name, value, isCustom) {
      const attr = isCustom ? name : opr.Toolkit.utils.getAttributeName(name);
      this.ref.setAttribute(attr, value);
    }

    removeAttribute(name, isCustom) {
      const attr = isCustom ? name : opr.Toolkit.utils.getAttributeName(name);
      this.ref.removeAttribute(attr);
    }

    setDataAttribute(name, value) {
      this.ref.dataset[name] = value;
    }

    removeDataAttribute(name) {
      delete this.ref.dataset[name];
    }

    setClassName(className = '') {
      this.ref.className = className;
    }

    setStyleProperty(prop, value) {
      this.ref.style[prop] = String(value);
    }

    removeStyleProperty(prop) {
      this.ref.style[prop] = null;
    }

    addListener(name, listener, isCustom) {
      const event = isCustom ? name : opr.Toolkit.utils.getEventName(name);
      this.ref.addEventListener(event, listener);
    }

    removeListener(name, listener, isCustom) {
      const event = isCustom ? name : opr.Toolkit.utils.getEventName(name);
      this.ref.removeEventListener(event, listener);
    }

    setProperty(key, value) {
      this.ref[key] = value;
    }

    deleteProperty(key, value) {
      delete this.ref[key];
    }

    insertChild(child, index) {
      if (!this.children) {
        this.children = [];
      }
      if (index === undefined) {
        index = this.children.length;
      }
      const nextChild = this.children[index];
      this.children.splice(index, 0, child);
      this.ref.insertBefore(child.ref, nextChild && nextChild.ref);
      child.parentNode = this;
    }

    moveChild(child, from, to) {
      opr.Toolkit.assert(
          this.children[from] === child,
          'Specified node is not a child of this element');
      this.children.splice(from, 1);
      this.children.splice(to, 0, child);
      this.ref.removeChild(child.ref);
      this.ref.insertBefore(child.ref, this.ref.children[to]);
    }

    replaceChild(child, node) {
      const index = this.children.indexOf(child);
      opr.Toolkit.assert(
          index >= 0, 'Specified node is not a child of this element');
      this.children.splice(index, 1, node);
      child.parentNode = null;
      node.parentNode = this;
      child.ref.replaceWith(node.ref);
    }

    removeChild(child) {
      const index = this.children.indexOf(child);
      opr.Toolkit.assert(
          index >= 0, 'Specified node is not a child of this element');
      this.children.splice(index, 1);
      child.parentNode = null;
      this.ref.removeChild(child.ref);
    }

    setTextContent(text) {
      this.ref.textContent = text;
    }

    removeTextContent() {
      this.ref.textContent = '';
    }

    get nodeType() {
      return VirtualElement.NodeType;
    }

    isCompatible(node) {
      return super.isCompatible(node) && this.name === node.name;
    }

    attachDOM() {
      this.ref = opr.Toolkit.Renderer.createElement(this.description);
      if (this.children) {
        for (const child of this.children) {
          child.attachDOM();
          this.ref.appendChild(child.ref);
        }
      }
    }

    detachDOM() {
      for (const child of this.children) {
        child.detachDOM();
      }
      this.ref = null;
    }
  }

  class Comment extends VirtualNode {

    static get NodeType() {
      return 'comment';
    }

    constructor(text, parentNode) {
      super(null, parentNode);
      this.text = text;
      this.attachDOM();
    }

    get nodeType() {
      return Comment.NodeType;
    }

    attachDOM() {
      this.ref = document.createComment(this.text);
    }

    detachDOM() {
      this.ref = null;
    }
  }

  const CoreTypes = {
    VirtualNode,
    Component,
    Root,
    VirtualElement,
    Comment,
  };

  loader.define('core/nodes', CoreTypes);
}

{
  class Diff {

    /*
     * Creates a new instance bound to a root component
     * with an empty list of patches.
     */
    constructor(root) {
      this.root = root;
      this.patches = [];
    }

    /*
     * Adds the patch to the underlying list.
     */
    addPatch(patch) { return this.patches.push(patch); }

    /*
     * Applies all the patches onto the bound root node.
     */
    apply() {
      if (this.patches.length) {
        opr.Toolkit.Lifecycle.beforeUpdate(this.patches);
        for (const patch of this.patches) {
          patch.apply();
        }
        opr.Toolkit.Lifecycle.afterUpdate(this.patches);
      }
    }

    /*
     * Calculates and returns all patches needed for transformation
     * of the rendered DOM fragment from one state to another.
     */
    rootPatches(currentState, nextState) {

      if (!currentState) {
        this.addPatch(opr.Toolkit.Patch.initRootComponent(this.root));
      }

      if (Diff.deepEqual(currentState, nextState)) {
        return [];
      }

      const description = opr.Toolkit.Template.describe([
        this.root.constructor,
        nextState,
      ]);

      this.componentPatches(this.root, description);
      this.root.state = nextState;
      return this.patches;
    }

    /**
     * Renders the descendants with normalized props and children passed
     * from the parent component.
     *
     * Calculates the patches needed for transformation of a component
     * to match the given description.
     */
    componentPatches(component, description) {

      if (Diff.deepEqual(component.description, description)) {
        // TODO(aswitalski): do this properly!
        if (component.isRoot()) {
          if (component.state !== null) {
            return;
          }
        } else {
          return;
        }
      }

      const childDescription = opr.Toolkit.Renderer.render(
          component, description.props, description.childrenAsTemplates, true);
      this.componentChildPatches(component.child, childDescription,
                                 /*= parent */ component);

      this.addPatch(opr.Toolkit.Patch.updateNode(component, description));
    }

    componentChildPatches(child, description, parent) {

      const {
        Diff,
        Patch,
        VirtualDOM,
      } = opr.Toolkit;

      if (!child && !description) {
        return;
      }

      // insert
      if (!child && description) {
        const node = VirtualDOM.createFromDescription(description, parent);
        this.addPatch(Patch.appendChild(node, parent));
        return;
      }

      // remove
      if (child && !description) {
        this.addPatch(Patch.removeChild(child, parent));
        return;
      }

      // update
      if (child.description.isCompatible(description)) {
        if (Diff.deepEqual(child.description, description)) {
          return;
        }
        this.childPatches(child, description, parent);
        return;
      }

      // replace
      const node =
          VirtualDOM.createFromDescription(description, parent, this.root);
      this.addPatch(Patch.replaceChild(child, node, parent));
    }

    /*
     * Calculates patches for transformation of specified child node
     * to match given description.
     */
    childPatches(child, description) {
      if (child.isComponent()) {
        if (child.isRoot()) {
          return child.update(description);
        }
        return this.componentPatches(child, description);
      }
      if (child.isElement()) {
        return this.elementPatches(child, description);
      }
      throw new Error('Unsupported node type:', child.nodeType);
    }

    /*
     * Calculates patches for transformation of an element to match given
     * description.
     */
    elementPatches(element, description) {

      if (Diff.deepEqual(element.description, description)) {
        return;
      }

      const isDefined = value => value !== undefined && value !== null;

      this.classNamePatches(element.description.class, description.class,
                            element);
      this.stylePatches(element.description.style, description.style, element);
      this.attributePatches(element.description.attrs, description.attrs,
                            element);
      this.listenerPatches(element.description.listeners, description.listeners,
                           element);
      this.datasetPatches(element.description.dataset, description.dataset,
                          element);
      this.propertiesPatches(element.description.properties,
                             description.properties, element);

      if (element.description.custom || description.custom) {
        this.attributePatches(
            element.description.custom && element.description.custom.attrs,
            description.custom && description.custom.attrs, element, true);
        this.listenerPatches(
            element.description.custom && element.description.custom.listeners,
            description.custom && description.custom.listeners, element, true);
      }

      // TODO: handle text as a child
      if (isDefined(element.description.text) && !isDefined(description.text)) {
        this.addPatch(opr.Toolkit.Patch.removeTextContent(element));
      }
      if (element.children || description.children) {
        this.elementChildrenPatches(element.children, description.children,
                                    element);
      }
      if (isDefined(description.text) &&
          description.text !== element.description.text) {
        this.addPatch(
            opr.Toolkit.Patch.setTextContent(element, description.text));
      }

      this.addPatch(opr.Toolkit.Patch.updateNode(element, description));
    }

    classNamePatches(current = '', next = '', target) {
      if (current !== next) {
        this.addPatch(opr.Toolkit.Patch.setClassName(next, target));
      }
    }

    stylePatches(current = {}, next = {}, target) {
      const Patch = opr.Toolkit.Patch;

      const props = Object.keys(current);
      const nextProps = Object.keys(next);

      const added = nextProps.filter(prop => !props.includes(prop));
      const removed = props.filter(prop => !nextProps.includes(prop));
      const changed = props.filter(prop => nextProps.includes(prop) &&
                                           current[prop] !== next[prop]);

      for (let prop of added) {
        this.addPatch(Patch.setStyleProperty(prop, next[prop], target));
      }
      for (let prop of removed) {
        this.addPatch(Patch.removeStyleProperty(prop, target));
      }
      for (let prop of changed) {
        this.addPatch(Patch.setStyleProperty(prop, next[prop], target));
      }
    }

    attributePatches(current = {}, next = {}, target = null, isCustom = false) {
      const Patch = opr.Toolkit.Patch;

      const attrs = Object.keys(current);
      const nextAttrs = Object.keys(next);

      const added = nextAttrs.filter(attr => !attrs.includes(attr));
      const removed = attrs.filter(attr => !nextAttrs.includes(attr));
      const changed = attrs.filter(attr => nextAttrs.includes(attr) &&
                                           current[attr] !== next[attr]);

      for (let attr of added) {
        this.addPatch(Patch.setAttribute(attr, next[attr], target, isCustom));
      }
      for (let attr of removed) {
        this.addPatch(Patch.removeAttribute(attr, target, isCustom));
      }
      for (let attr of changed) {
        this.addPatch(Patch.setAttribute(attr, next[attr], target, isCustom));
      }
    }

    listenerPatches(current = {}, next = {}, target = null, isCustom = false) {
      const Patch = opr.Toolkit.Patch;

      const listeners = Object.keys(current);
      const nextListeners = Object.keys(next);

      const added = nextListeners.filter(event => !listeners.includes(event));
      const removed = listeners.filter(event => !nextListeners.includes(event));
      const changed = listeners.filter(
          event => nextListeners.includes(event) &&
                   current[event] !== next[event] &&
                   (current[event].source === undefined &&
                        next[event].source === undefined ||
                    current[event].source !== next[event].source));

      for (let event of added) {
        this.addPatch(Patch.addListener(event, next[event], target, isCustom));
      }
      for (let event of removed) {
        this.addPatch(
            Patch.removeListener(event, current[event], target, isCustom));
      }
      for (let event of changed) {
        this.addPatch(Patch.replaceListener(
            event, current[event], next[event], target, isCustom));
      }
    }

    datasetPatches(current = {}, next = {}, target) {
      const Patch = opr.Toolkit.Patch;

      const attrs = Object.keys(current);
      const nextAttrs = Object.keys(next);

      const added = nextAttrs.filter(attr => !attrs.includes(attr));
      const removed = attrs.filter(attr => !nextAttrs.includes(attr));
      const changed = attrs.filter(attr => nextAttrs.includes(attr) &&
                                           current[attr] !== next[attr]);

      for (let attr of added) {
        this.addPatch(Patch.setDataAttribute(attr, next[attr], target));
      }
      for (let attr of removed) {
        this.addPatch(Patch.removeDataAttribute(attr, target));
      }
      for (let attr of changed) {
        this.addPatch(Patch.setDataAttribute(attr, next[attr], target));
      }
    }

    propertiesPatches(current = {}, next = {}, target = null) {
      const Patch = opr.Toolkit.Patch;

      const keys = Object.keys(current);
      const nextKeys = Object.keys(next);

      const added = nextKeys.filter(key => !keys.includes(key));
      const removed = keys.filter(key => !nextKeys.includes(key));
      const changed =
          keys.filter(key => nextKeys.includes(key) &&
                             !Diff.deepEqual(current[key], next[key]));

      for (let key of added) {
        this.addPatch(Patch.setProperty(key, next[key], target));
      }
      for (let key of removed) {
        this.addPatch(Patch.deleteProperty(key, target));
      }
      for (let key of changed) {
        this.addPatch(Patch.setProperty(key, next[key], target));
      }
    }

    elementChildrenPatches(sourceNodes = [], targetDescriptions = [], parent) {

      const {
        Patch,
        Reconciler,
        VirtualDOM,
      } = opr.Toolkit;
      const Move = Reconciler.Move;

      const created = [];
      const createdNodesMap = new Map();

      const createNode = (description, key) => {
        const node =
            VirtualDOM.createFromDescription(description, parent, this.root);
        created.push(node);
        createdNodesMap.set(key, node);
        return node;
      };

      const from =
          sourceNodes.map((node, index) => node.description.key || index);
      const to = targetDescriptions.map((description, index) =>
                                            description.key || index);

      const getNode = (key, isMove) => {
        if (from.includes(key)) {
          return sourceNodes[from.indexOf(key)];
        }
        if (isMove) {
          return createdNodesMap.get(key);
        }
        const index = to.indexOf(key);
        return createNode(targetDescriptions[index], key);
      };

      if (opr.Toolkit.isDebug()) {
        const assertUniqueKeys = keys => {
          if (keys.length) {
            const uniqueKeys = [...new Set(keys)];
            if (uniqueKeys.length !== keys.length) {
              throw new Error('Non-unique keys detected in:', keys);
            }
          }
        };
        assertUniqueKeys(from);
        assertUniqueKeys(to);
      }

      const nodeFavoredToMove =
          sourceNodes.find(node => node.description.props &&
                                   node.description.props.beingDragged);

      const moves = Reconciler.calculateMoves(
          from, to, nodeFavoredToMove && nodeFavoredToMove.key);

      const children = [...sourceNodes];
      for (const move of moves) {
        const node = getNode(move.item, move.name === Move.Name.MOVE);
        switch (move.name) {
        case Move.Name.REMOVE:
          this.addPatch(Patch.removeChildNode(node, move.at, parent));
          Move.remove(node, move.at).make(children);
          continue;
        case Move.Name.INSERT:
          this.addPatch(Patch.insertChildNode(node, move.at, parent));
          Move.insert(node, move.at).make(children);
          continue;
        case Move.Name.MOVE:
          this.addPatch(Patch.moveChildNode(node, move.from, move.to, parent));
          Move.move(node, move.from, move.to).make(children);
          continue;
        }
      }
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (!created.includes(child)) {
          const targetDescription = targetDescriptions[i];
          this.elementChildPatches(child, targetDescription, parent);
        }
      }
    }

    elementChildPatches(child, description, parent) {
      if (child.description.isCompatible(description)) {
        if (opr.Toolkit.Diff.deepEqual(child.description, description)) {
          return;
        }
        this.childPatches(child, description, parent);
      } else {
        const node = opr.Toolkit.VirtualDOM.createFromDescription(
            description, parent, this.root);
        this.addPatch(opr.Toolkit.Patch.replaceChildNode(child, node, parent));
      }
    }

    /*
     * Returns a normalized type of given item.
     */
    static getType(item) {
      const type = typeof item;
      if (type !== 'object') {
        return type;
      }
      if (item === null) {
        return 'null';
      }
      if (Array.isArray(item)) {
        return 'array';
      }
      return 'object';
    }

    static deepEqual(current, next) {
      if (Object.is(current, next)) {
        return true;
      }
      const type = this.getType(current);
      const nextType = this.getType(next);
      if (type !== nextType) {
        return false;
      }
      if (type === 'array') {
        if (current.length !== next.length) {
          return false;
        }
        for (let i = 0; i < current.length; i++) {
          const equal = this.deepEqual(current[i], next[i]);
          if (!equal) {
            return false;
          }
        }
        return true;
      } else if (type === 'object') {
        if (current.constructor !== next.constructor) {
          return false;
        }
        const keys = Object.keys(current);
        const nextKeys = Object.keys(next);
        if (keys.length !== nextKeys.length) {
          return false;
        }
        keys.sort();
        nextKeys.sort();
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          if (key !== nextKeys[i]) {
            return false;
          }
          const equal = this.deepEqual(current[key], next[key]);
          if (!equal) {
            return false;
          }
        }
        return true;
      }
      return false;
    }
  }

  loader.define('core/diff', Diff);
}

{
  class Lifecycle {

    /*
     * onCreated(),
     * onAttached(),
     * onPropsReceived(nextProps),
     * onUpdated(prevProps),
     * onDestroyed(),
     * onDetached()
     */

    static onComponentCreated(component) {
      if (component.hasOwnMethod('onCreated')) {
        component.onCreated.call(component.sandbox);
      }
      if (component.child) {
        this.onNodeCreated(component.child);
      }
    }

    static onElementCreated(element) {
      if (element.children) {
        for (const child of element.children) {
          this.onNodeCreated(child);
        }
      }
    }

    static onNodeCreated(node) {
      if (node.isElement()) {
        return this.onElementCreated(node);
      }
      if (!node.isRoot()) {
        return this.onComponentCreated(node);
      }
    }

    static onRootCreated(root) {
      if (root.hasOwnMethod('onCreated')) {
        root.onCreated.call(root.sandbox);
      }
    }

    static onComponentAttached(component) {
      if (component.child) {
        this.onNodeAttached(component.child);
      }
      if (component.hasOwnMethod('onAttached')) {
        component.onAttached.call(component.sandbox);
      }
    }

    static onElementAttached(element) {
      if (element.children) {
        for (const child of element.children) {
          this.onNodeAttached(child);
        }
      }
    }

    static onNodeAttached(node) {
      if (node.isElement()) {
        return this.onElementAttached(node);
      }
      if (!node.isRoot()) {
        return this.onComponentAttached(node);
      }
    }

    static onNodeReceivedDescription(node, description) {
      if (node.isComponent()) {
        this.onComponentReceivedProps(node, description.props);
      }
    }

    static onNodeUpdated(node, prevDescription) {
      if (node.isComponent()) {
        this.onComponentUpdated(node, prevDescription.props);
      }
    }

    static onRootAttached(root) {
      if (root.hasOwnMethod('onAttached')) {
        root.onAttached.call(root.sandbox);
      }
    }

    static onComponentReceivedProps(component, nextProps = {}) {
      if (component.hasOwnMethod('onPropsReceived')) {
        component.onPropsReceived.call(component.sandbox, nextProps);
      }
    }

    static onComponentUpdated(component, prevProps = {}) {
      if (component.hasOwnMethod('onUpdated')) {
        component.onUpdated.call(component.sandbox, prevProps);
      }
    }

    static onComponentDestroyed(component) {
      component.destroy();
      if (component.hasOwnMethod('onDestroyed')) {
        component.onDestroyed.call(component.sandbox);
      }
      if (component.child) {
        this.onNodeDestroyed(component.child);
      }
    }

    static onElementDestroyed(element) {
      if (element.children) {
        for (const child of element.children) {
          this.onNodeDestroyed(child);
        }
      }
    }

    static onNodeDestroyed(node) {
      if (node.isElement()) {
        return this.onElementDestroyed(node);
      }
      if (!node.isRoot()) {
        return this.onComponentDestroyed(node);
      }
    }

    static onComponentDetached(component) {
      if (component.child) {
        this.onNodeDetached(component.child);
      }
      if (component.hasOwnMethod('onDetached')) {
        component.onDetached.call(component.sandbox);
      }
    }

    static onElementDetached(element) {
      if (element.children) {
        for (const child of element.children) {
          this.onNodeDetached(child);
        }
      }
    }

    static onNodeDetached(node) {
      if (node.isElement()) {
        return this.onElementDetached(node);
      }
      if (!node.isRoot()) {
        return this.onComponentDetached(node);
      }
    }

    static beforePatchApplied(patch) {
      const Type = opr.Toolkit.Patch.Type;
      switch (patch.type) {
        case Type.APPEND_CHILD:
          return this.onNodeCreated(patch.child);
        case Type.INIT_ROOT_COMPONENT:
          return this.onRootCreated(patch.root);
        case Type.INSERT_CHILD_NODE:
          return this.onNodeCreated(patch.node);
        case Type.REMOVE_CHILD_NODE:
          return this.onNodeDestroyed(patch.node);
        case Type.REMOVE_CHILD:
          return this.onNodeDestroyed(patch.child);
        case Type.REPLACE_CHILD:
          this.onNodeDestroyed(patch.child);
          this.onNodeCreated(patch.node);
          return;
        case Type.UPDATE_NODE:
          return this.onNodeReceivedDescription(patch.node, patch.description);
      }
    }

    static beforeUpdate(patches) {
      for (const patch of patches) {
        this.beforePatchApplied(patch);
      }
    }

    static afterPatchApplied(patch) {
      const Type = opr.Toolkit.Patch.Type;
      switch (patch.type) {
        case Type.APPEND_CHILD:
          return this.onNodeAttached(patch.child);
        case Type.INIT_ROOT_COMPONENT:
          return this.onRootAttached(patch.root);
        case Type.INSERT_CHILD_NODE:
          return this.onNodeAttached(patch.node);
        case Type.REMOVE_CHILD_NODE:
          return this.onNodeDetached(patch.node);
        case Type.REMOVE_CHILD:
          return this.onNodeDetached(patch.child);
        case Type.REPLACE_CHILD:
          this.onNodeDetached(patch.child);
          this.onNodeAttached(patch.node);
          return;
        case Type.UPDATE_NODE:
          return this.onNodeUpdated(patch.node, patch.prevDescription);
      }
    }

    static afterUpdate(patches) {
      patches = [...patches].reverse();
      for (const patch of patches) {
        this.afterPatchApplied(patch);
      }
    }
  }

  loader.define('core/lifecycle', Lifecycle);
}

{
  const INIT_ROOT_COMPONENT = {
    type: Symbol('init-root-component'),
    apply: function() {
      this.root.container.appendChild(this.root.placeholder.ref);
    },
  };
  const UPDATE_NODE = {
    type: Symbol('update-node'),
    apply: function() {
      this.node.description = this.description;
    },
  };

  const APPEND_CHILD = {
    type: Symbol('append-child'),
    apply: function() {
      const placeholder = this.parent.placeholder.ref;
      this.parent.appendChild(this.child);
      placeholder.replaceWith(this.child.ref);
    },
  };
  const REPLACE_CHILD = {
    type: Symbol('replace-child'),
    apply: function() {
      const ref = this.child.ref;
      this.parent.replaceChild(this.child, this.node);
      ref.replaceWith(this.node.ref);
    },
  };
  const REMOVE_CHILD = {
    type: Symbol('remove-child'),
    apply: function() {
      const ref = this.child.ref;
      this.parent.removeChild(this.child);
      ref.replaceWith(this.parent.placeholder.ref);
    },
  };

  const SET_ATTRIBUTE = {
    type: Symbol('set-attribute'),
    apply: function() {
      this.target.setAttribute(this.name, this.value, this.isCustom);
    },
  };
  const REMOVE_ATTRIBUTE = {
    type: Symbol('remove-attribute'),
    apply: function() {
      this.target.removeAttribute(this.name, this.isCustom);
    },
  };

  const SET_DATA_ATTRIBUTE = {
    type: Symbol('set-data-attribute'),
    apply: function() {
      this.target.setDataAttribute(this.name, this.value);
    },
  };
  const REMOVE_DATA_ATTRIBUTE = {
    type: Symbol('remove-data-attribute'),
    apply: function() {
      this.target.removeDataAttribute(this.name);
    },
  };

  const SET_STYLE_PROPERTY = {
    type: Symbol('set-style-property'),
    apply: function() {
      this.target.setStyleProperty(this.property, this.value);
    },
  };
  const REMOVE_STYLE_PROPERTY = {
    type: Symbol('remove-style-property'),
    apply: function() {
      this.target.removeStyleProperty(this.property);
    },
  };

  const SET_CLASS_NAME = {
    type: Symbol('set-class-name'),
    apply: function() {
      this.target.setClassName(this.className);
    },
  };

  const ADD_LISTENER = {
    type: Symbol('add-listener'),
    apply: function() {
      this.target.addListener(this.name, this.listener, this.isCustom);
    },
  };
  const REPLACE_LISTENER = {
    type: Symbol('replace-listener'),
    apply: function() {
      this.target.removeListener(this.name, this.removed, this.isCustom);
      this.target.addListener(this.name, this.added, this.isCustom);
    },
  };
  const REMOVE_LISTENER = {
    type: Symbol('remove-listener'),
    apply: function() {
      this.target.removeListener(this.name, this.listener, this.isCustom);
    },
  };

  const SET_PROPERTY = {
    type: Symbol('set-property'),
    apply: function() {
      this.target.setProperty(this.key, this.value);
    },
  };
  const DELETE_PROPERTY = {
    type: Symbol('delete-property'),
    apply: function() {
      this.target.deleteProperty(this.key);
    },
  };

  const INSERT_CHILD_NODE = {
    type: Symbol('insert-child-node'),
    apply: function() {
      this.parent.insertChild(this.node, this.at);
    },
  };
  const MOVE_CHILD_NODE = {
    type: Symbol('move-child-node'),
    apply: function() {
      this.parent.moveChild(this.node, this.from, this.to);
    },
  };
  const REPLACE_CHILD_NODE = {
    type: Symbol('replace-child-node'),
    apply: function() {
      this.parent.replaceChild(this.child, this.node);
    },
  };
  const REMOVE_CHILD_NODE = {
    type: Symbol('remove-child-node'),
    apply: function() {
      this.parent.removeChild(this.node);
    },
  };

  const SET_TEXT_CONTENT = {
    type: Symbol('set-text-content'),
    apply: function() {
      this.element.setTextContent(this.text);
    },
  };
  const REMOVE_TEXT_CONTENT = {
    type: Symbol('remove-text-content'),
    apply: function() {
      this.element.removeTextContent();
    },
  };

  const Types = {
    INIT_ROOT_COMPONENT,
    UPDATE_NODE,
    APPEND_CHILD,
    REPLACE_CHILD,
    REMOVE_CHILD,
    SET_ATTRIBUTE,
    REMOVE_ATTRIBUTE,
    SET_DATA_ATTRIBUTE,
    REMOVE_DATA_ATTRIBUTE,
    SET_STYLE_PROPERTY,
    REMOVE_STYLE_PROPERTY,
    SET_CLASS_NAME,
    ADD_LISTENER,
    REPLACE_LISTENER,
    REMOVE_LISTENER,
    SET_PROPERTY,
    DELETE_PROPERTY,
    INSERT_CHILD_NODE,
    MOVE_CHILD_NODE,
    REPLACE_CHILD_NODE,
    REMOVE_CHILD_NODE,
    SET_TEXT_CONTENT,
    REMOVE_TEXT_CONTENT,
  };
  const PatchTypes = Object.keys(Types).reduce((result, key) => {
    result[key] = Types[key].type;
    return result;
  }, {});

  class Patch {

    constructor(def) {
      this.type = def.type;
      this.apply = def.apply || opr.Toolkit.noop;
    }

    static initRootComponent(root) {
      const patch = new Patch(INIT_ROOT_COMPONENT);
      patch.root = root;
      return patch;
    }

    static updateNode(node, description) {
      const patch = new Patch(UPDATE_NODE);
      patch.node = node;
      patch.prevDescription = node.description;
      patch.description = description;
      return patch;
    }

    static appendChild(child, parent) {
      const patch = new Patch(APPEND_CHILD);
      patch.child = child;
      patch.parent = parent;
      return patch;
    }

    static removeChild(child, parent) {
      const patch = new Patch(REMOVE_CHILD);
      patch.child = child;
      patch.parent = parent;
      return patch;
    }

    static replaceChild(child, node, parent) {
      const patch = new Patch(REPLACE_CHILD);
      patch.child = child;
      patch.node = node;
      patch.parent = parent;
      return patch;
    }

    static setAttribute(name, value, target, isCustom) {
      const patch = new Patch(SET_ATTRIBUTE);
      patch.name = name;
      patch.value = value;
      patch.target = target;
      patch.isCustom = isCustom;
      return patch;
    }

    static removeAttribute(name, target, isCustom) {
      const patch = new Patch(REMOVE_ATTRIBUTE);
      patch.name = name;
      patch.target = target;
      patch.isCustom = isCustom;
      return patch;
    }

    static setDataAttribute(name, value, target) {
      const patch = new Patch(SET_DATA_ATTRIBUTE);
      patch.name = name;
      patch.value = value;
      patch.target = target;
      return patch;
    }

    static removeDataAttribute(name, target) {
      const patch = new Patch(REMOVE_DATA_ATTRIBUTE);
      patch.name = name;
      patch.target = target;
      return patch;
    }

    static setStyleProperty(property, value, target) {
      const patch = new Patch(SET_STYLE_PROPERTY);
      patch.property = property;
      patch.value = value;
      patch.target = target;
      return patch;
    }

    static removeStyleProperty(property, target) {
      const patch = new Patch(REMOVE_STYLE_PROPERTY);
      patch.property = property;
      patch.target = target;
      return patch;
    }

    static setClassName(className, target) {
      const patch = new Patch(SET_CLASS_NAME);
      patch.className = className;
      patch.target = target;
      return patch;
    }

    static addListener(name, listener, target, isCustom) {
      const patch = new Patch(ADD_LISTENER);
      patch.name = name;
      patch.listener = listener;
      patch.target = target;
      patch.isCustom = isCustom;
      return patch;
    }

    static replaceListener(name, removed, added, target, isCustom) {
      const patch = new Patch(REPLACE_LISTENER);
      patch.name = name;
      patch.removed = removed;
      patch.added = added;
      patch.target = target;
      patch.isCustom = isCustom;
      return patch;
    }

    static removeListener(name, listener, target, isCustom) {
      const patch = new Patch(REMOVE_LISTENER);
      patch.name = name;
      patch.listener = listener;
      patch.target = target;
      patch.isCustom = isCustom;
      return patch;
    }

    static setProperty(key, value, target) {
      const patch = new Patch(SET_PROPERTY);
      patch.key = key;
      patch.value = value;
      patch.target = target;
      return patch;
    }

    static deleteProperty(key, target) {
      const patch = new Patch(DELETE_PROPERTY);
      patch.key = key;
      patch.target = target;
      return patch;
    }

    static insertChildNode(node, at, parent) {
      const patch = new Patch(INSERT_CHILD_NODE);
      patch.node = node;
      patch.at = at;
      patch.parent = parent;
      return patch;
    }

    static moveChildNode(node, from, to, parent) {
      const patch = new Patch(MOVE_CHILD_NODE);
      patch.node = node;
      patch.from = from;
      patch.to = to;
      patch.parent = parent;
      return patch;
    }

    static replaceChildNode(child, node, parent) {
      const patch = new Patch(REPLACE_CHILD_NODE);
      patch.child = child;
      patch.node = node;
      patch.parent = parent;
      return patch;
    }

    static removeChildNode(node, at, parent) {
      const patch = new Patch(REMOVE_CHILD_NODE);
      patch.node = node;
      patch.at = at;
      patch.parent = parent;
      return patch;
    }

    static setTextContent(element, text) {
      const patch = new Patch(SET_TEXT_CONTENT);
      patch.element = element;
      patch.text = text;
      return patch;
    }

    static removeTextContent(element) {
      const patch = new Patch(REMOVE_TEXT_CONTENT);
      patch.element = element;
      return patch;
    }

    static get Type() {
      return PatchTypes;
    }
  }

  loader.define('core/patch', Patch);
}

{
  /*
   * Normalized description of a template.
   * Is used to calculate differences between nodes.
   */
  class Description {

    get childrenAsTemplates() {
      if (this.children) {
        return this.children.map(child => child.asTemplate);
      }
      return undefined;
    }

    get isComponent() {
      return this instanceof ComponentDescription;
    }

    get isElement() {
      return this instanceof ElementDescription;
    }

    isCompatible(description) {
      return this.constructor === description.constructor;
    }
  }

  /*
   * Defines a normalized description of a component.
   *
   * Enumerable properties:
   * - key (a unique node identifier within its parent),
   * - component (an object with meta information)
   * - children (an array of child nodes)
   * - props (an object of any component rendering props)
   *
   * Non-enumerable properties:
   * - asTemplate: returns component description as a normalized template
   */
  class ComponentDescription extends Description {

    constructor(component) {
      super();
      this.component = component;
      this.type = 'component';
    }

    isCompatible(description) {
      return super.isCompatible(description) &&
          this.component === description.component;
    }

    get isRoot() {
      return this.component.prototype instanceof opr.Toolkit.Root;
    }

    get asTemplate() {
      const template = [this.component];
      if (this.props) {
        template.push(this.props);
      }
      if (this.children) {
        template.push(...this.children.map(child => child.asTemplate));
      }
      return template;
    }
  }

  /*
   * Defines a normalized description of an element.
   *
   * Enumerable properties:
   * - key (a unique node identifier within its parent),
   * - name (a string representing tag name),
   * - text (a string representing text content),
   * - children (an array of child nodes),
   * - props (an object) defining:
   *    - class (a class name string)
   *    - style (an object for style property to string value mapping)
   *    - listeners (an object for event name to listener mapping)
   *    - attrs (an object for normalized attribute name to value mapping)
   *    - dataset (an object representing data attributes)
   *    - properties (an object for properties set directly on DOM element)
   *
   * Non-enumerable properties:
   * - asTemplate: returns element description as a normalized template
   */
  class ElementDescription extends Description {

    constructor(name) {
      super();
      this.name = name;
      this.type = 'element';
    }

    isCompatible(description) {
      return super.isCompatible(description) && this.name === description.name;
    }

    get asTemplate() {
      const template = [this.name];
      const props = {};
      if (this.key) {
        props.key = this.key;
      }
      if (this.class) {
        props.class = this.class;
      }
      if (this.style) {
        props.style = this.style;
      }
      if (this.attrs) {
        Object.assign(props, this.attrs);
      }
      if (this.dataset) {
        props.dataset = this.dataset;
      }
      if (this.listeners) {
        Object.assign(props, this.listeners);
      }
      if (this.properties) {
        props.properties = this.properties;
      }
      if (Object.keys(props).length) {
        template.push(props);
      }
      if (this.children) {
        template.push(...this.children.map(child => child.asTemplate));
      } else if (typeof this.text === 'string') {
        template.push(this.text);
      }
      return template;
    }
  }

  Description.ElementDescription = ElementDescription;
  Description.ComponentDescription = ComponentDescription;

  loader.define('core/description', Description);
}

{
  const Permission = {
    LISTEN_FOR_UPDATES: 'listen-for-updates',
    REGISTER_METHOD: 'register-method',
    INJECT_STYLESHEETS: 'inject-stylesheets',
  };

  class Plugin {

    constructor(manifest) {

      opr.Toolkit.assert(
          typeof manifest.name === 'string' && manifest.name.length,
          'Plugin name must be a non-empty string!');

      Object.assign(this, manifest);
      this.origin = manifest;

      if (this.permissions === undefined) {
        this.permissions = [];
      } else {
        opr.Toolkit.assert(
            Array.isArray(this.permissions),
            'Plugin permissions must be an array');
        this.permissions = this.permissions.filter(
            permission => Object.values(Permission).includes(permission));
      }

      const sandbox = this.createSandbox();
      if (typeof manifest.register === 'function') {
        this.register = () => manifest.register(sandbox);
      }
      if (typeof manifest.install === 'function') {
        this.install = async root => {
          const uninstall = await manifest.install(root);
          opr.Toolkit.assert(
              typeof uninstall === 'function',
              'The plugin installation must return the uninstall function!');
          return uninstall;
        }
      }
    }

    isListener() {
      return this.permissions.includes(Permission.LISTEN_FOR_UPDATES);
    }

    isStylesheetProvider() {
      return this.permissions.includes(Permission.INJECT_STYLESHEETS);
    }

    createSandbox() {
      const sandbox = {};
      for (const permission of this.permissions) {
        switch (permission) {
          case Permission.REGISTER_METHOD:
            sandbox.registerMethod = name =>
                opr.Toolkit.Sandbox.registerPluginMethod(name);
        }
      }
      return sandbox;
    }
  }

  class Registry {

    constructor() {
      this.plugins = new Map();
      this.cache = {
        listeners: [],
      };
      this[Symbol.iterator] = () => this.plugins.values()[Symbol.iterator]();
    }

    /*
     * Adds the plugin to the registry
     */
    add(plugin) {
      opr.Toolkit.assert(
          !this.isRegistered(plugin.name),
          `Plugin '${plugin.name}' is already registered!`);
      this.plugins.set(plugin.name, plugin);
      this.updateCache();
    }

    /*
     * Removes plugin from the registry with the specified name.
     * Returns the uninstall function if present.
     */
    remove(name) {
      const plugin = this.plugins.get(name);
      opr.Toolkit.assert(
          plugin, `No plugin found with the specified name: "${name}"`);
      this.plugins.delete(name);
      this.updateCache();
      const uninstall = this.uninstalls.get(name);
      if (uninstall) {
        this.uninstalls.delete(name);
        return uninstall;
      }
      return null;
    }

    /*
     * Checks if plugin with specified name exists in the registry.
     */
    isRegistered(name) {
      return this.plugins.has(name);
    }

    /*
     * Updates the cache.
     */
    updateCache() {
      const plugins = [...this.plugins.values()];
      this.cache.listeners = plugins.filter(plugin => plugin.isListener());
    }

    /*
     * Clears the registry and the cache.
     */
    clear() {
      this.plugins.clear();
      this.uninstalls.clear();
      this.cache.listeners.length = 0;
    }
  }

  class Plugins {

    constructor(root) {
      this.root = root;
      this.registry = new Registry();
      this.uninstalls = new Map();
      this[Symbol.iterator] = () => this.registry[Symbol.iterator]();
    }

    /*
     * Creates a Plugin instance from the manifest object and registers it.
     */
    register(plugin) {
      if (!(plugin instanceof Plugin)) {
        plugin = new Plugin(plugin);
      }
      if (plugin.register) {
        plugin.register();
      }
      this.registry.add(plugin);
    }

    async installAll() {
      for (const plugin of this.registry) {
        await this.install(plugin);
      }
    }

    async install(plugin) {
      if (this.root && plugin.install) {
        const uninstall = await plugin.install(this.root);
        this.uninstalls.set(plugin.name, uninstall);
      }
    }

    /*
     * Removes the plugin from the registry and invokes it's uninstall method
     * if present.
     */
    async uninstall(name) {
      const uninstall = this.uninstalls.get(name);
      if (uninstall) {
        await uninstall();
      }
    }

    /*
     * Uninstalls all the plugins from the registry.
     */
    async destroy() {
      for (const plugin of this.registry) {
        await this.uninstall(plugin.name);
      }
      this.root = null;
    }

    /*
     * Invokes listener methods on registered listener plugins.
     */
    notify(action, event) {
      switch (action) {
        case 'before-update':
          for (const listener of this.registry.cache.listeners) {
            listener.onBeforeUpdate(event);
          }
          return;
        case 'update':
          for (const listener of this.registry.cache.listeners) {
            listener.onUpdate(event);
          }
          return;
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    }
  }

  Plugins.Plugin = Plugin;

  loader.define('core/plugins', Plugins);
}

{
  const Name = {
    INSERT: Symbol('insert'),
    MOVE: Symbol('move'),
    REMOVE: Symbol('remove'),
  };

  class Move {

    constructor(name, item, props, make) {
      this.name = name;
      this.item = item;
      this.at = props.at;
      this.from = props.from;
      this.to = props.to;
      this.make = make;
    }

    static insert(item, at) {
      return new Move(Name.INSERT, item, {at}, items => {
        items.splice(at, 0, item);
      });
    }

    static move(item, from, to) {
      return new Move(Name.MOVE, item, {from, to}, items => {
        items.splice(from, 1);
        items.splice(to, 0, item);
      });
    }

    static remove(item, at) {
      return new Move(Name.REMOVE, item, {at}, items => {
        items.splice(at, 1);
      });
    }
  }

  class Reconciler {

    static comparator(a, b) {
      if (Object.is(a.key, b.key)) {
        return 0;
      }
      return a.key > b.key ? 1 : -1;
    }

    static calculateMoves(source, target, favoredToMove = null) {
      const moves = [];

      const createItem = function(key, index) {
        return ({key, index});
      };

      const before = source.map(createItem).sort(this.comparator);
      const after = target.map(createItem).sort(this.comparator);

      let removed = [];
      let inserted = [];

      while (before.length || after.length) {
        if (!before.length) {
          inserted = inserted.concat(after);
          break;
        }
        if (!after.length) {
          removed = removed.concat(before);
          break;
        }
        const result = this.comparator(after[0], before[0]);
        if (result === 0) {
          before.shift();
          after.shift()
        } else if (result === 1) {
          removed.push(before.shift());
        } else {
          inserted.push(after.shift());
        }
      }

      const sortByIndex = function(foo, bar) {
        return foo.index - bar.index
      };

      removed.sort(sortByIndex).reverse();
      inserted.sort(sortByIndex);

      const result = [...source];

      for (let item of removed) {
        const move = Move.remove(item.key, item.index);
        move.make(result);
        moves.push(move);
      }
      for (let item of inserted) {
        const move = Move.insert(item.key, item.index);
        move.make(result);
        moves.push(move);
      }

      if (opr.Toolkit.Diff.deepEqual(result, target)) {
        moves.result = result;
        return moves;
      }

      const calculateIndexChanges = (source, target, reversed = false) => {

        const moves = [];

        const moveItemIfNeeded = index => {
          const item = target[index];
          if (source[index] !== item) {
            const from = source.indexOf(item);
            const move = Move.move(item, from, index);
            move.make(source);
            moves.push(move);
          }
        };

        if (reversed) {
          for (let i = target.length - 1; i >= 0; i--) {
            moveItemIfNeeded(i);
          }
        } else {
          for (let i = 0; i < target.length; i++) {
            moveItemIfNeeded(i);
          }
        }
        moves.result = source;
        return moves;
      };

      const defaultMoves = calculateIndexChanges([...result], target);
      if (defaultMoves.length > 1 ||
          favoredToMove && defaultMoves.length === 1 &&
              defaultMoves[0].item !== favoredToMove) {
        const alternativeMoves =
            calculateIndexChanges([...result], target, /*= reversed*/ true);
        if (alternativeMoves.length <= defaultMoves.length) {
          moves.push(...alternativeMoves);
          moves.result = alternativeMoves.result;
          return moves;
        }
      }
      moves.push(...defaultMoves);
      moves.result = defaultMoves.result;
      return moves;
    }
  }

  Reconciler.Move = Move;
  Reconciler.Move.Name = Name;

  loader.define('core/reconciler', Reconciler);
}

{
  class Renderer {

    constructor(root) {
      this.root = root;
    }

    /*
     * Calls the component render method and transforms the returned template
     * into the normalised description of the rendered node.
     */
    static render(component, props = {}, children = []) {
      Object.assign(component.sandbox, {
        props,
        children,
      });
      const template = component.render.call(component.sandbox);
      return opr.Toolkit.Template.describe(template);
    }

    /*
     * Creates a new DOM Element based on the specified description.
     */
    static createElement(description) {
      const element = document.createElement(description.name);
      if (description.text) {
        element.textContent = description.text;
      }
      if (description.class) {
        element.className = description.class;
      }
      if (description.style) {
        for (const [prop, value] of Object.entries(description.style)) {
          element.style[prop] = value;
        }
      }
      if (description.listeners) {
        for (const [name, listener] of Object.entries(description.listeners)) {
          const event = opr.Toolkit.utils.getEventName(name);
          element.addEventListener(event, listener);
        }
      }
      if (description.attrs) {
        for (const [attr, value] of Object.entries(description.attrs)) {
          const name = opr.Toolkit.utils.getAttributeName(attr);
          element.setAttribute(name, value);
        }
      }
      if (description.dataset) {
        for (const [attr, value] of Object.entries(description.dataset)) {
          element.dataset[attr] = value;
        }
      }
      if (description.properties) {
        for (const [prop, value] of Object.entries(description.properties)) {
          element[prop] = value;
        }
      }
      if (description.custom) {
        if (description.custom.attrs) {
          const customAttributes = Object.entries(description.custom.attrs);
          for (const [name, value] of customAttributes) {
            element.setAttribute(name, value);
          }
        }
        if (description.custom.listeners) {
          const customListeners = Object.entries(description.custom.listeners);
          for (const [event, listener] of customListeners) {
            element.addEventListener(event, listener);
          }
        }
      }
      return element;
    }

    updateDOM(command, prevState, nextState) {
      const update = {
        command,
        root: this.root,
        state: {
          from: prevState,
          to: nextState,
        },
      };
      this.onBeforeUpdate(update);
      const patches = this.update(prevState, nextState);
      this.onUpdate({
        ...update,
        patches,
      });
    }

    onBeforeUpdate(update) {
      this.root.plugins.notify('before-update', update);
    }

    onUpdate(update) {
      this.root.plugins.notify('update', update);
    }

    update(prevState, nextState) {
      const diff = new opr.Toolkit.Diff(this.root);
      diff.rootPatches(prevState, nextState);
      diff.apply();
      return diff.patches;
    }

    destroy() {
      this.root = null;
    }
  }

  loader.define('core/renderer', Renderer);
}

{
  const isFunction = (target, property) =>
      typeof target[property] === 'function';

  const delegated = [
    'commands',
    'constructor',
    'container',
    'dispatch',
    'elementName',
    'preventDefault',
    'stopEvent',
  ];
  const methods = [
    'broadcast',
    'connectTo',
  ];
  const pluginMethods = [];

  const createBoundListener = (listener, component, context) => {
    const boundListener = listener.bind(context);
    boundListener.source = listener;
    boundListener.component = component;
    return boundListener;
  };

  class Sandbox {

    static registerPluginMethod(name) {
      pluginMethods.push(name);
    }

    static create(component) {
      const blacklist =
          Object.getOwnPropertyNames(opr.Toolkit.Component.prototype);
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
              return target.renderedNode;
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
            return autobound[property] =
                       createBoundListener(target[property], target, receiver);
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

  loader.define('core/sandbox', Sandbox);
}

{
  class Service {

    static validate(listeners) {
      if (opr.Toolkit.isDebug()) {
        // clang-format off
        /* eslint-disable max-len */
        const keys = Object.keys(listeners);
        opr.Toolkit.assert(
            this.events instanceof Array,
            `Service "${this.name}" does not provide information about valid events, implement "static get events() { return ['foo', 'bar']; }"`);
        opr.Toolkit.assert(
            this.events.length > 0,
            `Service "${this.name}" returned an empty list of valid events, the list returned from "static get event()" must contain at least one event name`);
        const unsupportedKeys =
            Object.keys(listeners).filter(key => !this.events.includes(key));
        for (const unsupportedKey of unsupportedKeys) {
          opr.Toolkit.warn(
              `Unsupported listener specified "${unsupportedKey}" when connecting to ${this.name}`);
        }
        const supportedKeys = this.events.filter(event => keys.includes(event));
        opr.Toolkit.assert(
            supportedKeys.length > 0,
            `No valid listener specified when connecting to ${this.name}, use one of [${this.events.join(', ')}]`);
        for (const supportedKey of supportedKeys) {
          opr.Toolkit.assert(
              listeners[supportedKey] instanceof Function,
              `Specified listener "${supportedKey}" for ${this.name} is not a function`);
        }
        /* eslint-enable max-len */
        // clang-format on
      }
      return this.events.filter(event => listeners[event] instanceof Function);
    }
  }

  loader.define('core/service', Service);
}

{
  const isDefined = value => value !== undefined && value !== null;
  const isFalsy = template => template === null || template === false;
  const isNotEmpty = object => Boolean(Object.keys(object).length);

  class Template {

    /*
     * Creates a normalized Description of given template.
     */
    static describe(template) {

      if (isFalsy(template)) {
        return null;
      }

      if (Array.isArray(template) && template.length) {

        const {
          ComponentDescription,
          ElementDescription,
        } = opr.Toolkit.Description;

        let description;
        for (const [item, type, index] of template.map(
                 (item, index) => [item, this.getItemType(item), index])) {
          if (index === 0) {
            switch (type) {
            case 'string':
              description = new ElementDescription(item);
              break;
            case 'component':
            case 'function':
            case 'symbol':
              description = new ComponentDescription(
                  opr.Toolkit.resolveComponentClass(item, type));
              break;
            default:
              console.error('Invalid node type:', item,
                            `(${type}) at index: ${index}, template:`,
                            template);
              throw new Error(`Invalid node type specified: ${type}`);
            }
            continue;
          }
          if (index === 1 && type === 'props') {
            if (description.type === 'component') {
              const props = this.getComponentProps(
                  item, description.component, description.isRoot);
              if (props) {
                description.props = props;
                if (props.key) {
                  description.key = props.key;
                }
              }
              continue;
            }
            this.assignPropsToElement(item, description);
            continue;
          }
          if (isFalsy(item)) {
            continue;
          }
          if (type === 'string' || type === 'number' || item === true) {
            if (description.component) {
              console.error(
                  `Invalid text item found at index: ${index}, template:`,
                  template);
              throw new Error('Components cannot define text content');
            }
            if (description.children) {
              console.error(
                  `Invalid node item found at index: ${index}, template:`,
                  template);
              throw new Error(
                  'Elements with child nodes cannot define text content');
            }
            description.text = String(item);
            continue;
          } else if (type === 'node') {
            if (typeof description.text === 'string') {
              console.error(
                  `Invalid node item found at index: ${index}, template:`,
                  template);
              throw new Error('Text elements cannot have child nodes!');
            }
            description.children = description.children || [];
            description.children.push(this.describe(item));
          } else {
            console.error('Invalid item', item, `at index: ${index}, template:`,
                          template);
            throw new Error(`Invalid item specified: ${type}`);
          }
        }

        return description;
      }

      console.error('Invalid template definition:', template);
      throw new Error('Expecting array, null or false');
    }

    static getComponentProps(object, ComponentClass, isRoot) {
      const props = isRoot
                        ? object
                        : this.normalizeComponentProps(object, ComponentClass);
      return isNotEmpty(props) ? props : null;
    }

    /*
     * Supplements given object with default props for given class.
     * Returns either a non-empty props object or null.
     */
    static normalizeComponentProps(props = {}, ComponentClass) {
      return this.normalizeProps(props, ComponentClass.defaultProps);
    }

    /*
     * Returns a new props object supplemented by overriden values.
     */
    static normalizeProps(...overrides) {
      const result = {};
      for (const override of overrides) {
        for (const [key, value] of Object.entries(override || {})) {
          if (result[key] === undefined && value !== undefined) {
            result[key] = value;
          }
        }
      }
      return result;
    }

    /*
     * Normalizes specified element props object and returns either
     * a non-empty object containing only supported props or null.
     */
    static assignPropsToElement(props, description) {
      for (const [key, value] of Object.entries(props)) {
        if (key === 'key') {
          if (isDefined(value)) {
            description.key = value;
          }
        } else if (key === 'class') {
          const className = this.getClassName(value);
          if (className) {
            description.class = className;
          }
        } else if (key === 'style') {
          const style = this.getStyle(value);
          if (style) {
            description.style = style;
          }
        } else if (key === 'dataset') {
          const dataset = this.getDataset(value);
          if (dataset) {
            description.dataset = dataset;
          }
        } else if (key === 'properties') {
          const properties = this.getProperties(value);
          if (properties) {
            description.properties = properties;
          }
        } else if (key === 'attrs') {
          const customAttrs = this.getCustomAttributes(value);
          if (customAttrs) {
            description.custom = description.custom || {};
            description.custom.attrs = customAttrs;
          }
        } else if (key === 'on') {
          const customListeners = this.getCustomListeners(value);
          if (customListeners) {
            description.custom = description.custom || {};
            description.custom.listeners = customListeners;
          }
        } else {

          const {
            SUPPORTED_ATTRIBUTES,
            SUPPORTED_EVENTS,
          } = opr.Toolkit;

          if (SUPPORTED_ATTRIBUTES.includes(key)) {
            const attr = this.getAttributeValue(value);
            if (isDefined(attr)) {
              description.attrs = description.attrs || {};
              description.attrs[key] = attr;
            }
          } else if (SUPPORTED_EVENTS.includes(key)) {
            const listener = this.getListener(value, key);
            if (listener) {
              description.listeners = description.listeners || {};
              description.listeners[key] = value;
            }
          } else {
            console.warn('Unsupported property:', key);
          }
        }
      }
    }

    /*
     * Returns the type of item used in the array representing node template.
     */
    static getItemType(item) {
      const type = typeof item;
      switch (type) {
      case 'function':
        if (item.prototype instanceof opr.Toolkit.Component) {
          return 'component';
        }
        return 'function';
      case 'object':
        if (item === null) {
          return 'null';
        } else if (Array.isArray(item)) {
          return 'node';
        } else if (item.constructor === Object) {
          return 'props';
        }
        return 'unknown';
      default:
        return type;
      }
    }

    /*
     * Resolves any object to a space separated string of class names.
     */
    static getClassName(value) {
      if (!value) {
        return '';
      }
      if (typeof value === 'string') {
        return value;
      }
      if (Array.isArray(value)) {
        return value
            .reduce(
                (result, item) => {
                  if (!item) {
                    return result;
                  }
                  if (typeof item === 'string') {
                    result.push(item);
                    return result;
                  }
                  result.push(this.getClassName(item));
                  return result;
                },
                [])
            .filter(item => item)
            .join(' ');
      }
      if (typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length === 0) {
          return '';
        }
        return Object.keys(value)
            .map(key => value[key] && key)
            .filter(item => item)
            .join(' ');
      }
      throw new Error(`Invalid value: ${JSON.stringify(value)}`);
    }

    /*
     * Returns either a non-empty style object containing only understood
     * styling rules or null.
     */
    static getStyle(object) {

      opr.Toolkit.assert(object.constructor === Object,
                         'Style must be a plain object!');

      const isSupported = key => opr.Toolkit.SUPPORTED_STYLES.includes(key);

      const reduceToNonEmptyValues = (style, [name, value]) => {
        const string = this.getStyleProperty(value, name);
        if (string !== null) {
          style[name] = string;
        }
        return style;
      };

      const entries = Object.entries(object);

      if (opr.Toolkit.isDebug()) {
        for (const [key, value] of entries.filter(([key]) =>
                                                      !isSupported(key))) {
          console.warn(`Unsupported style property, key: ${key}, value:`,
                       value);
        }
      }

      const style = Object.entries(object)
                        .filter(([key, value]) => isSupported(key))
                        .reduce(reduceToNonEmptyValues, {});
      return isNotEmpty(style) ? style : null;
    }

    static getStyleProperty(value, name) {
      if (typeof value === 'string') {
        return value || '\'\'';
      } else if ([true, false, null, undefined].includes(value)) {
        return null;
      } else if (Array.isArray(value)) {
        return value.join('');
      } else if (typeof value === 'number') {
        return String(value);
      } else if (typeof value === 'object') {
        let whitelist;
        if (name === 'filter') {
          whitelist = opr.Toolkit.SUPPORTED_FILTERS;
        } else if (name === 'transform') {
          whitelist = opr.Toolkit.SUPPORTED_TRANSFORMS;
        } else {
          throw new Error(`Unknown function list: ${JSON.stringify(value)}`);
        }
        return this.getFunctionList(value, whitelist);
      }
      throw new Error(`Invalid style property value: ${JSON.stringify(value)}`);
    }

    /*
     * Returns a multi-property string value.
     */
    static getFunctionList(object, whitelist) {
      const composite = {};
      let entries = Object.entries(object);
      if (whitelist) {
        entries = entries.filter(([key, value]) => whitelist.includes(key));
      }
      for (const [key, value] of entries) {
        const stringValue = this.getAttributeValue(value, false);
        if (stringValue !== null) {
          composite[key] = stringValue;
        }
      }
      return Object.entries(composite)
          .map(([key, value]) => `${key}(${value})`)
          .join(' ');
    }

    static getListener(value, name) {
      if (typeof value === 'function') {
        return value;
      }
      if (value === null || value === false || value === undefined) {
        return null;
      }
      throw new Error(`Invalid listener specified for event: ${name}`);
    }

    /*
     * Resolves given value to a string.
     */
    static getAttributeValue(value, allowEmpty = true) {
      if (value === true || value === '') {
        return allowEmpty ? '' : null;
      } else if (typeof value === 'string') {
        return value;
      } else if ([null, false, undefined].includes(value)) {
        return null;
      } else if (Array.isArray(value)) {
        return value.join('');
      } else if (['object', 'function', 'symbol'].includes(typeof value)) {
        throw new Error(`Invalid attribute value: ${JSON.stringify(value)}!`);
      }
      return String(value);
    }

    /*
     * Returns either a non-empty dataset object or null.
     */
    static getDataset(object) {
      const dataset = {};
      for (const key of Object.keys(object)) {
        const value = this.getAttributeValue(object[key]);
        if (value !== null) {
          dataset[key] = value;
        }
      }
      return isNotEmpty(dataset) ? dataset : null;
    }

    /*
     * Returns either a non-empty object containing properties set
     * directly on a rendered DOM Element or null.
     */
    static getProperties(object) {
      return isNotEmpty(object) ? object : null;
    }

    static getCustomAttributes(object) {
      console.assert(
          object.constructor === Object,
          'Expecting object for custom attributes!');
      const attrs = {};
      for (const [key, value] of Object.entries(object)) {
        const attr = this.getAttributeValue(value, true);
        if (attr !== null) {
          attrs[key] = attr;
        }
      }
      return isNotEmpty(attrs) ? attrs : null;
    }

    static getCustomListeners(object) {
      console.assert(
          object.constructor === Object,
          'Expecting object for custom listeners!');
      const listeners = {};
      for (const [key, value] of Object.entries(object)) {
        const listener = this.getListener(value, key);
        if (listener) {
          listeners[key] = listener;
        }
      }
      return isNotEmpty(listeners) ? listeners : null;
    }
  }

  loader.define('core/template', Template);
}

{
  class VirtualDOM {

    /*
     * Creates a new Virtual DOM structure from given description.
     */
    static createFromDescription(description, parentNode) {
      if (!description) {
        return null;
      }
      if (description.isElement) {
        return new opr.Toolkit.VirtualElement(description, parentNode);
      }
      if (description.isComponent) {
        return this.createComponent(description, parentNode);
      }
      throw new Error(`Unsupported node type: ${description.type}`)
    }

    /*
     * Creates a new component instance from given description.
     */
    static createComponent(description, parentNode) {
      const ComponentClass = description.component;
      if (ComponentClass.prototype instanceof opr.Toolkit.Root) {
        return this.createRoot(
            ComponentClass, description.props,
            parentNode && parentNode.rootNode,
            /*= requireCustomElement */ true);
      }
      const component = new ComponentClass(description, parentNode);
      const childDescription = opr.Toolkit.Renderer.render(
          component, description.props, description.childrenAsTemplates);
      if (childDescription) {
        const child = this.createFromDescription(childDescription, component);
        component.appendChild(child);
      }
      return component;
    }

    /*
     * Creates a new root instance from given description.
     *
     * If the root class declares a custom element name
     */
    static createRoot(
        component, props = {}, originator = opr.Toolkit,
        requireCustomElement = false) {

      const description = opr.Toolkit.Template.describe([
        component,
      ]);
      try {
        const ComponentClass = description.component;
        if (requireCustomElement && !ComponentClass.elementName) {
          throw new Error(
              `Root component "${
                                 ComponentClass.displayName
                               }" does not define custom element name!`);
        }
        return new ComponentClass(description, props, originator);
      } catch (error) {
        console.error('Error rendering root component:', description);
        throw error;
      }
    }
  }

  loader.define('core/virtual-dom', VirtualDOM);
}

{
  const INIT = Symbol('init');
  const SET_STATE = Symbol('set-state');
  const UPDATE = Symbol('update');

  const coreReducer = (state, command) => {
    if (command.type === INIT) {
      return command.state;
    }
    if (command.type === SET_STATE) {
      return command.state;
    }
    if (command.type === UPDATE) {
      return {
        ...state,
        ...command.state,
      };
    }
    return state;
  };

  coreReducer.commands = {
    init: state => ({
      type: INIT,
      state,
    }),
    setState: state => ({
      type: SET_STATE,
      state,
    }),
    update: state => ({
      type: UPDATE,
      state,
    }),
  };

  const combineReducers = (...reducers) => {
    const commands = {};
    const reducer = (state, command) => {
      [coreReducer, ...reducers].forEach(reducer => {
        state = reducer(state, command);
      });
      return state;
    };
    [coreReducer, ...reducers].forEach(reducer => {
      const defined = Object.keys(commands);
      const incoming = Object.keys(reducer.commands);

      const overriden = incoming.find(key => defined.includes(key));
      if (overriden) {
        console.error(
            'Reducer:', reducer,
            `conflicts an with exiting one with method: "${overriden}"`);
        throw new Error(`The "${overriden}" command is already defined!`)
      }

      Object.assign(commands, reducer.commands);
    });
    reducer.commands = commands;
    return reducer;
  };

  const throttle = (fn, wait = 200, delayFirstEvent = false) => {

    let lastTimestamp = 0;
    let taskId = null;

    let context;
    let params;

    return function throttled(...args) {
      /* eslint-disable no-invalid-this */
      if (!taskId) {
        const timestamp = Date.now();
        const elapsed = timestamp - lastTimestamp;
        const scheduleTask = delay => {
          taskId = setTimeout(() => {
            taskId = null;
            lastTimestamp = Date.now();
            return fn.call(context, ...params);
          }, delay);
        };
        if (elapsed >= wait) {
          lastTimestamp = timestamp;
          if (!delayFirstEvent) {
            return fn.call(this, ...args);
          }
          scheduleTask(wait);
        } else {
          scheduleTask(wait - elapsed);
        }
      }
      context = this;
      params = args;
      /* eslint-enable no-invalid-this */
    };
  };

  const debounce = (fn, wait = 200) => {

    let taskId = null;

    let context;
    let params;

    return function debounced(...args) {
      /* eslint-disable no-invalid-this */
      if (taskId) {
        clearTimeout(taskId);
      }
      taskId = setTimeout(() => {
        taskId = null;
        return fn.call(context, ...params);
      }, wait);

      context = this;
      params = args;
      /* eslint-enable no-invalid-this */
    };
  };

  const addDataPrefix = attr => `data${attr[0].toUpperCase()}${attr.slice(1)}`;

  const lowerDash = name => {
    if (name.startsWith('aria')) {
      return `aria-${name.slice(4).toLowerCase()}`;
    }
    return name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  }

  const getAttributeName = name => {
    switch (name) {
      case 'accessKey':
      case 'allowFullScreen':
      case 'allowTransparency':
      case 'autoComplete':
      case 'autoFocus':
      case 'autoPlay':
      case 'cellPadding':
      case 'cellSpacing':
      case 'charSet':
      case 'classID':
      case 'colSpan':
      case 'contentEditable':
      case 'contextMenu':
      case 'crossOrigin':
      case 'dateTime':
      case 'encType':
      case 'frameBorder':
      case 'hrefLang':
      case 'inputMode':
      case 'keyType':
      case 'marginHeight':
      case 'marginWidth':
      case 'maxLength':
      case 'minLength':
      case 'noValidate':
      case 'radioGroup':
      case 'readOnly':
      case 'rowSpan':
      case 'spellCheck':
      case 'srcDoc':
      case 'srcLang':
      case 'srcSet':
      case 'useMap':
      case 'tabIndex':
        return name.toLowerCase();
      default:
        return lowerDash(name);
    }
  };

  const getEventName = name => {
    switch (name) {
      case 'onDoubleClick':
        return 'dblclick';
      default:
        return name.slice(2).toLowerCase();
    }
  };

  const createUUID = () => {
    const s4 = () =>
        Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
    return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`;
  };

  const isSpecialProperty =
      prop => ['key', 'class', 'style', 'dataset', 'properties'].includes(prop);

  const isSupportedAttribute = attr => isSpecialProperty(attr) ||
      opr.Toolkit.SUPPORTED_ATTRIBUTES.includes(attr) ||
      opr.Toolkit.SUPPORTED_EVENTS.includes(attr);

  const postRender = fn => {

    // since Chromium 64 there are some problems with animations not being
    // triggered correctly, this hack solves the problem across all OS-es

    /* eslint-disable prefer-arrow-callback */
    requestAnimationFrame(function() {
      requestAnimationFrame(fn);
    });
    /* eslint-enable prefer-arrow-callback */
  };

  const Utils = {
    throttle,
    debounce,
    combineReducers,
    addDataPrefix,
    lowerDash,
    getAttributeName,
    getEventName,
    createUUID,
    isSupportedAttribute,
    isSpecialProperty,
    postRender,
  };

  loader.define('core/utils', Utils);
}

{
  const INIT = Symbol('init');

  /* Function to Component mapping. */
  const pureComponentClassRegistry = new Map();

  class Toolkit {

    constructor() {
      this.roots = new Set();
      this.settings = null;
      this.ready = new Promise(resolve => {
        this[INIT] = resolve;
      });
      this.assert = console.assert;
    }

    async configure(options) {
      const settings = {};
      settings.debug = options.debug || false;
      Object.freeze(settings);
      this.settings = settings;
      this.plugins = this.createPlugins(options.plugins);
      this[INIT](true);
    }

    createPlugins(manifests = []) {
      const plugins = new opr.Toolkit.Plugins(null);
      for (const manifest of manifests) {
        plugins.register(manifest);
      }
      return plugins;
    }

    /*
     * Returns resolved Component class.
     */
    resolveComponentClass(component, type) {
      switch (type) {
        case 'component':
          return component;
        case 'function':
          return this.resolvePureComponentClass(component);
        case 'symbol':
          return this.resolveLoadedClass(String(component).slice(7, -1));
        default:
          throw new Error(`Unsupported component type: ${type}`);
      }
    }

    /*
     * Returns a PureComponent class rendering the template
     * provided by the specified function.
     */
    resolvePureComponentClass(fn) {
      let ComponentClass = pureComponentClassRegistry.get(fn);
      if (ComponentClass) {
        return ComponentClass;
      }
      ComponentClass = class PureComponent extends opr.Toolkit.Component {
        render() {
          fn.bind(this)(this.props);
        }
      };
      ComponentClass.renderer = fn;
      pureComponentClassRegistry.set(fn, ComponentClass);
      return ComponentClass;
    }

    /*
     * Returns a component class resolved by module loader
     * with the specified id.
     */
    resolveLoadedClass(id) {
      const ComponentClass = loader.get(id);
      if (!ComponentClass) {
        throw new Error(`Error resolving component class for '${id}'`);
      }
      if (!(ComponentClass.prototype instanceof opr.Toolkit.Component)) {
        console.error('Module:', ComponentClass,
                      'is not a component extending opr.Toolkit.Component!');
        throw new Error(
            `Module defined with id "${id}" is not a component class.`);
      }
      return ComponentClass;
    }

    track(root) {
      this.roots.add(root);
    }

    stopTracking(root) {
      this.roots.delete(root);
    }

    get tracked() {
      const tracked = [];
      for (const root of this.roots) {
        tracked.push(root, ...root.tracked);
      }
      return tracked;
    }

    isDebug() {
      return Boolean(this.settings && this.settings.debug);
    }

    warn(...messages) {
      if (this.isDebug()) {
        console.warn(...messages);
      }
    }

    async createRoot(component, props = {}) {
      if (typeof component === 'string') {
        const RootClass = await loader.preload(component);
        if (RootClass.prototype instanceof opr.Toolkit.Root) {
          return opr.Toolkit.VirtualDOM.createRoot(RootClass, props, this);
        }
        console.error(
            'Specified class is not a root component: ', ComponentClass);
        throw new Error('Invalid root class!');
      }
      const description = opr.Toolkit.Template.describe([
        component,
      ]);
      return opr.Toolkit.VirtualDOM.createRoot(
          description.component, props, this);
    }

    async render(component, container, props = {}) {
      await this.ready;
      const root = await this.createRoot(component, props);
      this.track(root);
      await root.mount(container);
      await root.ready;
      return root;
    }

    async create(options = {}) {
      const toolkit = new Toolkit();
      await toolkit.configure(options);
      return toolkit;
    }
  }

  loader.define('core/toolkit', Toolkit);
}

{
  const Toolkit = loader.get('core/toolkit');

  const consts = loader.get('core/consts');
  const nodes = loader.get('core/nodes');

  Object.assign(Toolkit.prototype, consts, nodes, {
    Description: loader.get('core/description'),
    Diff: loader.get('core/diff'),
    Lifecycle: loader.get('core/lifecycle'),
    Patch: loader.get('core/patch'),
    Plugins: loader.get('core/plugins'),
    Reconciler: loader.get('core/reconciler'),
    Renderer: loader.get('core/renderer'),
    Sandbox: loader.get('core/sandbox'),
    Service: loader.get('core/service'),
    Template: loader.get('core/template'),
    VirtualDOM: loader.get('core/virtual-dom'),
    utils: loader.get('core/utils'),
    noop: () => {},
  });

  window.opr = window.opr || {};
  window.opr.Toolkit = new Toolkit();
}
