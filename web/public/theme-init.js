(() => {
  try {
    const savedTheme = localStorage.getItem('oplogs-theme')
    const theme = savedTheme === 'dark' || savedTheme === 'light'
      ? savedTheme
      : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0a0d0b' : '#dfe1e1')
  } catch (_error) {
    document.documentElement.dataset.theme = 'light'
  }
})()
