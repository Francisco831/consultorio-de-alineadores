"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { invitarMail, revocarInvitacion } from "@/lib/actions/allowlist";
import { formatDate } from "@/lib/format";

export interface InvitacionRow {
  id: string;
  email: string;
  active: boolean;
  note: string | null;
  added_at: string;
  removed_at: string | null;
}

export function AllowlistManager({
  invitaciones,
  isManager,
}: {
  invitaciones: InvitacionRow[];
  isManager: boolean;
}) {
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();

  function correr(fd: FormData, limpiar?: () => void) {
    startTransition(async () => {
      const res = await invitarMailOrRevoke(fd);
      if (res.error) toast.error(res.error);
      else {
        toast.success(res.ok ?? "Listo");
        limpiar?.();
      }
    });
  }

  async function invitarMailOrRevoke(fd: FormData) {
    return fd.get("id") ? revocarInvitacion(fd) : invitarMail(fd);
  }

  const activas = invitaciones.filter((i) => i.active);
  const bajas = invitaciones.filter((i) => !i.active);

  return (
    <div className="space-y-3">
      <form
        action={(fd) =>
          correr(fd, () => {
            setEmail("");
            setNote("");
          })
        }
        className="flex flex-wrap items-end gap-2"
      >
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="al-email">
            Email
          </label>
          <Input
            id="al-email"
            name="email"
            type="email"
            placeholder="nombre@keepsmiling.com.ar"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={!isManager || pending}
            className="w-64"
            required
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="al-note">
            Motivo (opcional)
          </label>
          <Input
            id="al-note"
            name="note"
            placeholder="reemplazo de Itzel"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={!isManager || pending}
            className="w-56"
          />
        </div>
        <Button disabled={!isManager || pending}>Invitar</Button>
      </form>

      <div className="rounded-md border">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Email</th>
              <th className="px-3 py-2 text-left font-medium">Invitado</th>
              <th className="px-3 py-2 text-left font-medium">Motivo</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {activas.map((i) => (
              <tr key={i.id} className="border-b last:border-0">
                <td className="px-3 py-2 font-medium">{i.email}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {formatDate(i.added_at)}
                </td>
                <td className="px-3 py-2 text-muted-foreground">{i.note ?? "—"}</td>
                <td className="px-3 py-2 text-right">
                  <form action={(fd) => correr(fd)}>
                    <input type="hidden" name="id" value={i.id} />
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!isManager || pending}
                    >
                      Dar de baja
                    </Button>
                  </form>
                </td>
              </tr>
            ))}
            {bajas.map((i) => (
              <tr key={i.id} className="border-b text-muted-foreground last:border-0">
                <td className="px-3 py-2">
                  <span className="line-through">{i.email}</span>{" "}
                  <Badge variant="outline">de baja</Badge>
                </td>
                <td className="px-3 py-2">
                  {i.removed_at ? formatDate(i.removed_at) : "—"}
                </td>
                <td className="px-3 py-2">{i.note ?? "—"}</td>
                <td className="px-3 py-2 text-right text-xs">
                  volver a invitar con el formulario
                </td>
              </tr>
            ))}
            {invitaciones.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-muted-foreground" colSpan={4}>
                  La lista está vacía. Mientras lo esté, el guard deja pasar cualquier
                  alta para que una base nueva se pueda arrancar.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        Quién puede tener cuenta. Es el respaldo del interruptor de registro público:
        un alta cuyo mail no esté acá no llega a existir, aunque ese interruptor se
        encienda por error. <strong>Dar de baja no echa a nadie</strong> — solo impide
        crear una cuenta nueva con ese mail; quien ya entra, sigue entrando.
      </p>
    </div>
  );
}
