/**
 * cytoscape-fcose ships no types. It is registered as a Cytoscape extension and
 * only ever referenced by layout name, so the default export is all we need.
 */
declare module 'cytoscape-fcose' {
  import type { Ext } from 'cytoscape';
  const fcose: Ext;
  export default fcose;
}
