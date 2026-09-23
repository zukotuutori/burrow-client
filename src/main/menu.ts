import { app, Menu, type MenuItemConstructorOptions } from 'electron'

/**
 * macOS gets a small menu so Cmd+C/V/Q work. There is no "Close Window" item, so Cmd+W reaches the app.
 * Linux gets no menu: its default accelerators (Ctrl+C, Ctrl+R, Ctrl+W) would steal keys from the shell.
 */
export function buildMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        // DevTools only exist in development builds.
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as const]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
