# opera-toolkit

Opera Toolkit is a UI library created for rendering Opera Desktop browser's internal Web pages.
It allows to build the user interface natively by utilising the engine's latest features.

## Why?

All JavaScript frameworks are intended for rendering Web pages which work across a variety of browsers with diversified support for latest HTML5+ features. That results in compromises and requires a number of techniques to make this possible - transpilation, polyfills, external live-reload servers to name a few.

A solution dedicated for a single browser asks for a different approach, an attempt to use as many tools provided by the browser itself as possible. Support for async/await, object spread and other syntactic sugar allows to write nifty code without any need of transpilation. Native templating system - Bragi - makes possible to describe rendered DOM elements and components with arrays and objects. Single execution environment pushes away the worries of browser compatibility issues. DevTools workspaces provide built-in live reload system, neither external tools nor constant builds and browser restarts are necessary.

## Design principles

* **native** - take advantage of the latest Chromium engine features,
* **modular** - define each component, reducer, service as a separate module,
* **dynamic** - build in discovery service, lazy-load modules for flexibility or preload for performance,
* **fast** - utilise virtual DOM, minimise the number of DOM modifications, benchmark all operations to ensure high performance,
* **simple** - no millions of callbacks and events, utilise one-way model-to-view binding and unidirectional data flow,
* **encapsulated** - isolate apps as Web components, reduce usage of global variables to bare minimum,
* **deterministic** - do not worry about race conditions, let the framework control the asynchronous operations properly,
* **testable** - unit test all your components with little effort,
* **debuggable** - easily inspect your apps, use live reload, instrumentation and time saving debug tools.

## UI first

Building user interfaces for a browser requires pretty much two things: a mechanism to render the view and the way to load and manipulate the data utilised by that view.

Opera Toolkit builds the UI as a sandboxed app that renders DOM elements in the specified container.

As a rule of thumb, no excess resources are fetched unless they are needed to render the requested interface.
Dependencies required for showing particular UI fragments are defined within the components responsible for rendering those fragments. All dependencies are resolved with the built-in discovery service and module loader.

Apps can be isolated within custom elements as Web components.
Multiple apps rendered on the same page share dependencies, as these are stateless by design. All stateful components are encapsulated within apps.

## Example

```js
class Counter extends opr.Toolkit.Component {

  static defaultProps = {
    value: 0;
  };

  onUpdated() {
    setTimeout(this.increment, 1000);
  }

  increment() {
    this.commands.update({
      value: this.props.value + 1,
    });
  }

  render() {
    render [
      'div',
      `Value: ${this.props.value}`,
    ];
  }
}

opr.Toolkit.render(Counter, document.body);

```

## Demo
```sh
npm install
npm run release
npm run demo
```
