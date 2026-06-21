/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 设为 "true" 时走 mocks/response.json 假数据（仅本地离线开发）。 */
  readonly VITE_USE_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
