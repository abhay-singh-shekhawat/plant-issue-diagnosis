/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    darkMode: 'class',
    theme: {
        extend: {
            colors: {
                paper: 'var(--sc-paper)',
                surface: 'var(--sc-surface)',
                ink: 'var(--sc-ink)',
                muted: 'var(--sc-muted)',
                line: 'var(--sc-line)',
                accent: 'var(--sc-accent)',
                'accent-ink': 'var(--sc-accent-ink)',
                warn: 'var(--sc-warn)',
                danger: 'var(--sc-danger)',
                mist: 'var(--sc-mist)',
                warnwash: 'var(--sc-warnwash)',
                dangerwash: 'var(--sc-dangerwash)',
            },
            fontFamily: {
                display: ['"Space Grotesk"', '"Mukta"', 'system-ui', 'sans-serif'],
                body: ['"Mukta"', 'system-ui', 'sans-serif'],
                mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
            },
            borderRadius: {
                surface: '14px',
                input: '10px',
            },
            boxShadow: {
                'sc-sm': '0 1px 2px rgb(29 33 27 / 0.06)',
                'sc-md': '0 8px 24px rgb(29 33 27 / 0.08)',
            },
        },
    },
    plugins: [],
}
