// An installation address that is safe to paste into a shell: host, optional port and a plain path,
// nothing a shell would read as anything but text (spec B5 «kit de conexión»).
export const SAFE_URL = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/
