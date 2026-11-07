// Vite's `?url` suffix returns the address of an emitted static asset.
declare module "*.mjs?url" {
  const url: string;
  export default url;
}
