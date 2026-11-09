// The icons of the web (plan canvas-ui D11): drawn here, on a 24px grid with a 1.6px line in the colour of
// the text, so they follow the theme and the state they sit in. They are decoration: the control that
// holds one always has a name of its own.

const ring = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`

const PATHS = {
  search: `${ring(11, 11, 6.5)}M16 16l4.5 4.5`,
  home: 'M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H5.5A1.5 1.5 0 0 1 4 19z',
  overview:
    'M4 5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v8H4zM13 4h6a1 1 0 0 1 1 1v4h-7zM13 11h7v8a1 1 0 0 1-1 1h-6zM4 15h7v5H5a1 1 0 0 1-1-1z',
  proposals:
    'M4 13.5 6.6 5.8A1.2 1.2 0 0 1 7.7 5h8.6a1.2 1.2 0 0 1 1.1.8L20 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM4 13.5h4.5l1.5 2.5h4l1.5-2.5H20',
  wiki: 'M12 6.5C10 5 7.5 4.5 4 4.5v14c3.5 0 6 .5 8 2 2-1.5 4.5-2 8-2v-14c-3.5 0-6 .5-8 2zM12 6.5v14',
  decisions: 'M6 21V4M6 4.5h11.5l-2.5 4 2.5 4H6',
  log: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v3.5H8M12 8v4.5l3 2',
  graph: `${ring(6, 7, 2.2)}${ring(18, 6, 2.2)}${ring(12, 18, 2.2)}M8.2 6.8l7.6-.6M7.1 8.9l3.8 7.2M17 8l-4 7.9`,
  journal:
    'M7 3.5h10.5a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H7zM7 3.5v17M10.5 8.5h5M10.5 12h5M4.5 7.5H7M4.5 12H7M4.5 16.5H7',
  activity: 'M3 12h4l2.5-6.5 5 13 2.5-6.5h4',
  health:
    'M12 19.5s-7.5-4.4-7.5-9.7A4.2 4.2 0 0 1 12 7.3a4.2 4.2 0 0 1 7.5 2.5c0 5.3-7.5 9.7-7.5 9.7zM7.5 12h2.5l1-2 2 4 1-2h2.5',
  settings: `M4 7h9M19 7h1M4 17h1M11 17h9${ring(16, 7, 2.5)}${ring(8, 17, 2.5)}`,
  people: `${ring(9, 8, 3.5)}M3 20c.5-3.5 3-5.5 6-5.5s5.5 2 6 5.5M16 4.6a3.4 3.4 0 0 1 0 6.8M18 14.8c1.8.7 2.8 2.4 3 5.2`,
  help: `${ring(12, 12, 9)}M9.6 9.6a2.5 2.5 0 1 1 3.5 2.2c-.7.4-1.1.9-1.1 1.7M12 16.6v.4`,
  review:
    'M9 3.5h6v3H9zM9 5H6.5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H15M8.8 14l2.4 2.4 4.3-4.8',
  panel: 'M4.5 4.5h15a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1zM9.5 4.5v15',
  inspector: 'M4.5 4.5h15a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1zM14.5 4.5v15',
  updown: 'M8 9.5l4-4 4 4M8 14.5l4 4 4-4',
  right: 'M10 6l6 6-6 6',
  down: 'M6 10l6 6 6-6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  zoomIn: `${ring(11, 11, 6.5)}M16 16l4.5 4.5M8.5 11h5M11 8.5v5`,
  zoomOut: `${ring(11, 11, 6.5)}M16 16l4.5 4.5M8.5 11h5`,
  fit: 'M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  warn: 'M12 4.5 20.5 19.5h-17zM12 10v4.5M12 17v.4',
  info: `${ring(12, 12, 9)}M12 11v5.5M12 7.8v.4`,
  filter: 'M4 5h16l-6 7.5V19l-4 2v-8.5z',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.5M4.5 12h.5M4.5 18h.5',
  user: `${ring(12, 8, 4)}M4.5 20.5c.8-4 3.8-6 7.5-6s6.7 2 7.5 6`,
  connect: 'M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 0 1-11 0zM12 16.5V21',
  admin: 'M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z',
  moon: 'M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z',
  signOut: 'M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 8l-4 4 4 4M6 12h10',
  keyboard:
    'M3.5 6.5h17a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM7 10h.5M11 10h.5M15 10h.5M7 14h10',
  layers: 'M12 4 3.5 8.5 12 13l8.5-4.5zM3.5 12.5 12 17l8.5-4.5M3.5 16 12 20.5l8.5-4.5',
} as const

export type IconName = keyof typeof PATHS

export const ICON_NAMES = Object.keys(PATHS) as IconName[]

export function Icon({ name, size = 18, class: cls }: { name: IconName; size?: number; class?: string }) {
  return (
    <svg
      class={cls ? `icon ${cls}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
