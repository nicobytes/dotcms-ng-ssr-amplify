# Spike 1: Angular SSR (Express) en AWS Amplify Hosting

**Objetivo:** confirmar que el ejemplo `examples/angular-ssr` de dotCMS corre en Amplify Hosting
(compute) y documentar qué hay que cambiar y qué falla. Contexto: RBC GAM (FD 41404).

Docs de referencia:
- [Deployment specification](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-deployment-specification.html)
- [Deploying an Express server](https://docs.aws.amazon.com/amplify/latest/userguide/deploy-express-server.html)
- [Deploying SSR apps](https://docs.aws.amazon.com/amplify/latest/userguide/server-side-rendering-amplify.html)

## Lo que ya está verificado en local

- `npm run build:amplify` genera `.amplify-hosting/` (compute de ~2.3 MB, límite 220 MB).
- El bundle es **autocontenido**: funciona copiado a otra carpeta sin `node_modules`.
- El entry escucha en `:3000`; un host permitido devuelve 200 y uno no permitido devuelve 400.
- Modo por ruta: con `index.html` (no `indexFile.html`) las rutas `RenderMode.Client` (SPA) funcionan; probado en local con `/blog`.
- No verificado: nada de esto corrió todavía en Amplify (CloudFront, runtime Lambda, variables de entorno).

## Parte A: preparar el repo (en tu máquina)

1. Requisitos: Node `^22.22.3`, `^24.15` o `>=26` (probado con 24.20).
2. Crear `.env` con un token de **solo lectura** de una instancia de prueba (por ejemplo demo):
   ```
   DOTCMS_URL=https://demo.dotcms.com
   DOTCMS_AUTH_TOKEN=<token>
   DOTCMS_SITE_ID=<site id>
   SPIKE_DEBUG=true
   ```
3. Probar el bundle local:
   ```bash
   npm ci
   npm run build:amplify
   npm run start:amplify
   curl -i localhost:3000/
   ```
4. Subir a un repo Git propio (Amplify se conecta a GitHub, GitLab, Bitbucket o CodeCommit):
   ```bash
   git add -A && git commit -m "Angular SSR on Amplify spike"
   gh repo create angular-ssr-amplify --private --source . --push
   ```
   `.env` está en `.gitignore`: el token **no** se sube al repo.

## Parte B: configurar Amplify (primera vez)

### B0. Cuenta de AWS
Pide a Cloud Eng una cuenta o rol **sandbox** con permisos sobre Amplify, IAM (crear el service role),
CloudWatch Logs y CloudFront. No uses una cuenta de producción ni de un cliente.

### B1. Crear la app
1. Consola de AWS, región por defecto de Cloud Eng (por ejemplo `us-east-1`), servicio **AWS Amplify**.
2. **Create new app** y elige tu proveedor Git. Autoriza el acceso a GitHub (solo al repo del spike).
3. Elige el repo `angular-ssr-amplify` y la rama `main`. **Next**.

### B2. App settings
1. **Build settings:** Amplify detecta `amplify.yml` del repo. Debe mostrar `baseDirectory: .amplify-hosting`.
   Si propone otra cosa, pega el contenido de `amplify.yml`.
2. **Advanced settings:**
   - **Enable SSR app logs:** actívalo. Para frameworks que no son Next.js hay que activarlo a mano.
   - **Environment variables:** agrega
     | Variable | Valor |
     | --- | --- |
     | `DOTCMS_URL` | URL de la instancia de prueba |
     | `DOTCMS_AUTH_TOKEN` | token de solo lectura |
     | `DOTCMS_SITE_ID` | id del sitio |
     | `SPIKE_DEBUG` | `true` (quitar después del spike) |
     | `NG_ALLOWED_HOSTS` | opcional: dominio propio, separado por comas |
3. **Service role:** elige **Create and use a new service role** (Amplify lo usa para escribir logs en CloudWatch).
4. **Next**, revisa y **Save and deploy**.

### B3. Seguir el build
En la consola, abre el deploy y mira las fases: **Provision, Build, Deploy, Verify**.
- Build: debe imprimir `node -v` con la v24 y `.amplify-hosting ready. compute: ...`.
- Deploy: si falla la validación del manifest, el error lo dirá ahí.

La URL queda como `https://main.<appId>.amplifyapp.com`.

## Parte C: checklist de verificación

Sustituye `$URL` por la URL de Amplify.

```bash
# 1. ¿Es HTML renderizado en el servidor? (debe traer contenido, no solo <app-root></app-root>)
curl -s $URL/ | head -c 800

# 2. ¿Qué host y headers llegan al compute? (requiere SPIKE_DEBUG=true)
curl -s $URL/__spike/headers

# 3. Host no permitido (debe dar 400)
curl -s -o /dev/null -w "%{http_code}\n" -H 'Host: evil.com' $URL/

# 4. Estáticos con caché larga
curl -sI $URL/robots.txt
# 5. Headers de caché de una página SSR (insumo para la pregunta de dotCDN)
curl -sI $URL/ | grep -i -E 'cache-control|x-cache|via'
```

Preguntas que el spike debe responder (anota el resultado de cada una):

| # | Pregunta | Resultado |
| --- | --- | --- |
| 1 | ¿Renderiza la home con HTML del servidor? | |
| 2 | ¿Qué `host` y `x-forwarded-host` llegan? ¿Funciona el allowlist? | |
| 3 | ¿Llegan las variables de entorno al runtime (cargadas desde `.env`)? | |
| 4 | ¿Funciona el fetch en proceso a `/data/page`? | |
| 5 | Tamaño del compute y tiempo de cold start | |
| 6 | ¿Qué `Cache-Control` salen en páginas SSR y estáticos? | |
| 7 | ¿Funciona UVE (editor visual) contra el deploy? | |
| 8 | ¿Se pueden poner dotCDN/dominio propio por delante? | |

## Problemas probables

| Síntoma | Causa probable | Qué hacer |
| --- | --- | --- |
| Build falla con "engine" de Node | La imagen no tiene Node ^22.22.3 o ^24.15 | Revisar el `nvm install 24` del `amplify.yml` o usar Live package override |
| "failed to validate the deploy manifest" | `deploy-manifest.json` ausente o inválido en `.amplify-hosting` | Revisar la salida del postbuild |
| 400 "Header host ... not allowed" | El host no está en el allowlist | Agregar el dominio a `NG_ALLOWED_HOSTS`; ver `/__spike/headers` |
| 500 y logs vacíos | SSR logs desactivados o sin service role | Activar "Enable SSR app logs" y revisar CloudWatch |
| Página sin contenido de dotCMS | Variables `DOTCMS_*` no llegaron al runtime | Revisar que el build escribió `.env` y que el postbuild lo copió |

## Notas de seguridad del spike

- El postbuild copia `.env` al bundle (supuesto del spike: Amplify no inyecta las variables de la consola
  en el compute de apps que no son Next.js). Eso deja el token dentro del artefacto de deploy.
  Para algo real: Secrets Manager o SSM Parameter Store, no `.env`.
- `/__spike/headers` expone headers de la petición: solo para el spike, con `SPIKE_DEBUG=true`.
