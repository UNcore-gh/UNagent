import React, { useCallback, useEffect, useMemo, useState } from 'react'

import type ObsidianAI from '../main'
import type { ObsidianAISettings } from '../settings/settings'

interface SettingsContextType {
  settings: ObsidianAISettings
  setSettings: (newSettings: ObsidianAISettings) => Promise<void>
}

const SettingsContext = React.createContext<SettingsContextType | undefined>(
  undefined,
)

export const SettingsProvider = ({
  children,
  plugin,
}: {
  children: React.ReactNode
  plugin: ObsidianAI
}) => {
  const [settings, setSettingsState] = useState<ObsidianAISettings>(
    plugin.settings,
  )

  // Keep React state in sync when settings change from anywhere (e.g. the
  // native settings tab), via the plugin's change-listener registry.
  useEffect(() => {
    return plugin.addSettingsChangeListener((newSettings) => {
      setSettingsState(newSettings)
    })
  }, [plugin])

  const setSettings = useCallback(
    async (newSettings: ObsidianAISettings) => {
      plugin.settings = newSettings
      await plugin.saveSettings()
    },
    [plugin],
  )

  const value = useMemo(
    () => ({ settings, setSettings }),
    [settings, setSettings],
  )

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  )
}

export const useSettings = (): SettingsContextType => {
  const context = React.useContext(SettingsContext)
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider')
  }
  return context
}
