declare global {
  const VCODER_VERSION: string
  const VCODER_CHANNEL: string
}

export const InstallationVersion = typeof VCODER_VERSION === "string" ? VCODER_VERSION : "local"
export const InstallationChannel = typeof VCODER_CHANNEL === "string" ? VCODER_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
