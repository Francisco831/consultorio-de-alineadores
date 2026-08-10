import { signIn } from "@/lib/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#001d57] p-4">
      <div className="w-full max-w-sm space-y-6 rounded-2xl bg-background p-8 shadow-2xl">
        <div className="space-y-3 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element -- logo estático local */}
          <img
            src="/KS-logo.png"
            alt="KeepSmiling"
            className="mx-auto h-12 w-auto"
          />
          <p className="text-sm text-muted-foreground">
            CRM México · Commercial Operating System
          </p>
        </div>
        <form action={signIn} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="tu@keepsmiling.com.ar"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Contraseña</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : null}
          <Button type="submit" className="w-full">
            Entrar
          </Button>
        </form>
        <p className="text-center text-xs text-muted-foreground">
          Acceso solo por invitación. Pedile una cuenta a Pancho.
        </p>
      </div>
    </div>
  );
}
