declare module "katex" {
  import katex from "katex/katex.ts";
  export * from "katex/src/types/fonts.ts";
  export * from "katex/src/domTree.ts";
  export * from "katex/src/defineMacro.ts";
  export * from "katex/src/Settings.ts";
  export * from "katex/src/Token.ts";
  export default katex;
}
