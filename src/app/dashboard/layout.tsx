import { redirect } from "next/navigation";
import { auth } from "~/server/auth";
import { Sidebar } from "./_components/sidebar";
import { Header } from "./_components/header";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session) {
    redirect("/");
  }

  return (
    <div className="flex h-screen" style={{ backgroundColor: 'var(--color-raycast-bg-secondary)' }}>
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <Header />
        <main className="flex-1 overflow-x-auto overflow-y-auto" style={{ backgroundColor: 'var(--color-raycast-bg)' }}>
          <div className="p-6">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}