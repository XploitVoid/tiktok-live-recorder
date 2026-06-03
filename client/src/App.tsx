import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '@/lib/i18n'
import { Header } from '@/components/Header'
import { HomePage } from '@/pages/HomePage'

// Code-split the heavier pages so the initial Home bundle stays small.
// Grid, Replay, and Dashboard each pull in their own panel components and
// (for Grid/Replay) chart-style rendering — none of which the Home page needs.
const GridPage = lazy(() => import('@/pages/GridPage').then((m) => ({ default: m.GridPage })))
const ReplayPage = lazy(() => import('@/pages/ReplayPage').then((m) => ({ default: m.ReplayPage })))
const DashboardPage = lazy(() => import('@/pages/DashboardPage').then((m) => ({ default: m.DashboardPage })))

function PageFallback() {
  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="animate-pulse text-sm text-muted-foreground">Loading…</div>
    </div>
  )
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-5xl mx-auto p-4 md:p-6 space-y-5">
      <Header />
      {children}
    </div>
  )
}

function App() {
  return (
    <BrowserRouter>
      <I18nProvider>
        <TooltipProvider>
          <div className="dark min-h-screen bg-background text-foreground">
            <Suspense fallback={<PageFallback />}>
              <Routes>
                <Route path="/" element={<Layout><HomePage /></Layout>} />
                <Route path="/grid" element={<GridPage />} />
                <Route path="/replay" element={<ReplayPage />} />
                <Route path="/dashboard" element={<DashboardPage />} />
              </Routes>
            </Suspense>
            <Toaster position="top-right" richColors closeButton />
          </div>
        </TooltipProvider>
      </I18nProvider>
    </BrowserRouter>
  )
}

export default App
