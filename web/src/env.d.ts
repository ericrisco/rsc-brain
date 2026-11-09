// Stylesheets are imported for their effect; Vite bundles them into a hashed file.
declare module '*.css'
// A file imported for its address: Vite copies it under /assets and gives its hashed URL.
declare module '*?url' {
  const url: string
  export default url
}
