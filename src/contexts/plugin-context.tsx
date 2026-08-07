import React from 'react'

import type ObsidianAI from '../main'

const PluginContext = React.createContext<ObsidianAI | undefined>(undefined)

export const PluginProvider = ({
  children,
  plugin,
}: {
  children: React.ReactNode
  plugin: ObsidianAI
}) => {
  return (
    <PluginContext.Provider value={plugin}>{children}</PluginContext.Provider>
  )
}

export const usePlugin = (): ObsidianAI => {
  const plugin = React.useContext(PluginContext)
  if (!plugin) {
    throw new Error('usePlugin must be used within a PluginProvider')
  }
  return plugin
}
