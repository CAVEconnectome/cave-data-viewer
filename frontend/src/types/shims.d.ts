// The plotly cartesian-dist-min build doesn't ship types, but we only use it
// as the engine handed to react-plotly.js/factory — the factory's signature is
// what matters for type-checking, not the inner Plotly object.
declare module "plotly.js-cartesian-dist-min";
