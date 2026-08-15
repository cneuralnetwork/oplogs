const byteUnits = ['B', 'KB', 'MB', 'GB', 'TB']

export function humanBytes(bytes: number) {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < byteUnits.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit ? 1 : 0)} ${byteUnits[unit]}`
}

export function formatDateTime(value: string) {
  return new Date(value).toLocaleString()
}

export function formatTime(value: string) {
  return new Date(value).toLocaleTimeString()
}
