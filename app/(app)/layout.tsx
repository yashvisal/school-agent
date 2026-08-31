import { AppShell } from "@/components/shell/app-shell"

/**
 * Every app route renders inside the shell (nav sidebar | viewport | rail).
 * `sign-in` / `sign-up` sit outside this group so Clerk owns the whole page.
 */
export default function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <AppShell>{children}</AppShell>
}
