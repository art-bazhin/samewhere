interface ImportMetaEnv {
  readonly VITE_GAMEANALYTICS_GAME_KEY?: string;
  readonly VITE_GAMEANALYTICS_SECRET_KEY?: string;
}

declare module 'virtual:samewhere-lighting' {
  const url: string;
  export default url;
  export const revision: string;
}
