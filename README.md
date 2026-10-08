# MediChain — Sistema de triage con IoT, IA generativa y anclaje en blockchain

Prototipo desarrollado como trabajo de grado de Ingeniería en Electrónica y Telecomunicaciones
(Universidad del Cauca): *Diseño e implementación de un sistema clínico de gestión de triage
integrado con blockchain*. Autores: Katerine Samboní Guevara y Juan Felipe Paredes Galvis.

> **Prototipo académico.** Validado en condiciones controladas, con casos simulados, sensores de
> prototipado (MAX30102, MLX90614) y la red de prueba Polygon Amoy. No es un dispositivo médico ni
> está listo para uso clínico.

## Propósito

MediChain apoya el registro del triage en urgencias en tres frentes:

| Problema | Componente |
| --- | --- |
| Transcripción manual de signos vitales | Dispositivo ESP32 que envía FC, SpO2 y temperatura por Bluetooth Low Energy |
| Variabilidad en la clasificación | Sugerencia de nivel generada por Gemini que el profesional acepta o modifica (con justificación) |
| Registros modificables sin rastro | Hash SHA-256 de cada registro anclado en un contrato inteligente en Polygon Amoy |

La auditoría recalcula el hash de cada registro guardado en MongoDB y comprueba que esté anclado en
el contrato. Si no lo está, el registro se marca como **ALTERADO**.

## Arquitectura

```
 ┌──────────────┐  BLE (Web Bluetooth)  ┌────────────────────────────┐
 │ ESP32 +      │ ────────────────────▶ │ SPA React (navegador)      │
 │ MAX30102 +   │                       │  Triage · Admisión ·       │
 │ MLX90614     │                       │  Auditoría · Admin         │
 └──────────────┘                       └──────┬──────────────┬──────┘
                                    REST/JSON  │              │ ethers.js + MetaMask
                                               ▼              │ (roles y lectura de hashes)
                              ┌──────────────────────────┐    │
                              │ Servidor Express (:3000) │    │
                              │  API · Relayer · Gemini  │    │
                              └──┬───────────┬───────────┘    │
                       Mongoose  │           │ JSON-RPC       ▼
                                 ▼           └──────▶ ┌─────────────────────┐
                        ┌───────────────┐             │ Contrato            │
                        │ MongoDB       │             │ MediChainTriage     │
                        │ (datos        │             │ (Polygon Amoy)      │
                        │  clínicos)    │             └─────────────────────┘
                        └───────────────┘
```

- **Frontend** (`src/`): React 18 + TypeScript + Vite. Vistas en `src/views/`, acceso a API,
  blockchain y Bluetooth en `src/services/`.
- **Backend** (`server.ts`, `server/models/`): Express + Mongoose. Calcula el hash y lo ancla en
  Polygon con la billetera del Relayer, que firma y paga la transacción (Relayer custodial).
- **Reglas compartidas** (`src/shared/`): campos y serialización del hash (`hashPayload.ts`) y
  campos obligatorios (`requiredFields.ts`), usados por cliente y servidor.
- **Firmware** (`arduino/`): captura y estabilización de signos vitales en el ESP32.
- **Contrato** (`contracts/MediChainTriage.sol`): Solidity 0.8.20, desarrollado en Remix IDE y
  desplegado en Polygon Amoy en
  [`0xa7e1c47b30Ef1a30E3cd46edD2147B4Eed7E6D6A`](https://amoy.polygonscan.com/address/0xa7e1c47b30Ef1a30E3cd46edD2147B4Eed7E6D6A).

Los diagramas C4 (contexto y contenedores) y el detalle de diseño están en los capítulos 5 y 6 de
la monografía.

### Qué detecta la auditoría y qué no

Cada registro se verifica contra su propia transacción de anclaje (`src/shared/anchorAudit.ts`). Detecta
la modificación de un campo incluido en el hash, el reemplazo por el contenido de otro registro anclado y
la eliminación de registros (hashes anclados sin registro). No detecta cambios en `attentionTimestamp` o
`aiModelUsed` (excluidos del hash), alteraciones previas al anclaje, ni un anclaje hecho por quien
controle la clave del Relayer o una wallet de médico registrada.

### Autenticación

Al iniciar sesión, el usuario firma con MetaMask un mensaje con un nonce (no es una transacción ni cuesta
gas). El servidor verifica la firma, consulta sus roles en el contrato y entrega un token de sesión que
cada petición a la API debe enviar; cada ruta exige su rol (`server/auth.ts`). Al guardar un triage, el
médico del registro debe ser la wallet de la sesión. Las sesiones viven en memoria: si el servidor se
reinicia, hay que volver a iniciar sesión.

## Requisitos

- Node.js 18 o superior
- MongoDB local (por defecto `mongodb://127.0.0.1:27017/medichain_thesis`)
- Google Chrome o Microsoft Edge (Web Bluetooth) con la extensión MetaMask
- Una URL RPC de Polygon Amoy y una billetera con POL de prueba para el Relayer
- Clave de API de Gemini
- Para el dispositivo: ESP32, MAX30102 y MLX90614 en I2C (SDA GPIO21, SCL GPIO22)

## Configuración

```bash
npm install
cp .env.example .env   # y completar los valores
```

| Variable | Uso |
| --- | --- |
| `GEMINI_API_KEY` | Sugerencia de triage con IA |
| `RELAYER_PRIVATE_KEY` | Billetera que firma y paga el anclaje en Polygon Amoy |
| `POLYGON_RPC_URL` | Nodo RPC de Polygon Amoy (chainId 80002) |
| `PATIENT_SALT` | Sal para seudonimizar la cédula antes de enviarla a la cadena. Obligatoria: sin ella el servidor no ancla registros |
| `MONGODB_URI` | Opcional; MongoDB local por defecto |
| `ENABLE_ATTACK_SIMULATION` | Solo pruebas: `true` habilita `PATCH /api/hack/:id` fuera de producción. Por defecto deshabilitada |
| `HOST` | Opcional; `127.0.0.1` por defecto (solo el propio equipo). `0.0.0.0` abre el servidor a la red local |
| `ADMIN_PRIVATE_KEY` | Opcional, solo para la prueba de integridad: cuenta owner con la que el script inicia sesión (por defecto, la del Relayer) |

La billetera del Relayer y las de los médicos deben estar autorizadas en el contrato
(`addDoctor`, desde la cuenta propietaria).

## Ejecución

```bash
npm run dev        # servidor + frontend en http://localhost:3000 (modo desarrollo)
npm run build      # compila frontend y servidor en dist/
NODE_ENV=production npm start
```

La ruta de simulación de ataques (`PATCH /api/hack/:id`) solo responde si `ENABLE_ATTACK_SIMULATION=true`
y `NODE_ENV` no es `production`; en cualquier otro caso devuelve 403. En el frontend, la consola de
simulación solo aparece en modo desarrollo.

Firmware: abrir `arduino/MediChain_Estabilizacion/MediChain_Estabilizacion.ino` en el IDE de
Arduino (núcleo ESP32 de Espressif) y cargarlo. El dispositivo se anuncia como `MediChain_IoT`.

## Pruebas

```bash
# Paridad del hash cliente/servidor (no requiere MongoDB ni red)
npx tsx tests/hash-parity.test.mts

# Detección de alteraciones (requiere servidor en desarrollo, MongoDB, POLYGON_RPC_URL
# y ENABLE_ATTACK_SIMULATION=true)
npx tsx tests/integrity-attack.test.mts                 # muestra el plan, no modifica nada
npx tsx tests/integrity-attack.test.mts --yes --n=12    # ejecuta la prueba
npx tsx tests/integrity-attack.test.mts --restore=tests/results/<archivo>.json --yes
```

Los resultados usados en la monografía están en `tests/results/`. Los datos de pacientes que
aparecen en ellos son ficticios.

## Estructura

```
server.ts                 API, Relayer, integración con Gemini y blockchain
server/auth.ts            Inicio de sesión con firma de la wallet y control de acceso por rol
server/models/            Esquemas Mongoose (Record, PendingPatient, TelemetryLog)
src/views/                Triage, Admisión, Auditoría, Admin, Benchmark, Login
src/services/             bluetooth, crypto, database, telemetry, web3
src/shared/               Reglas compartidas cliente/servidor (hash, campos obligatorios)
src/config/contract.ts    Dirección y ABI del contrato
contracts/                Código fuente del contrato inteligente
arduino/                  Firmware del ESP32
tests/                    Pruebas de paridad de hash e integridad, y sus resultados
```

## Licencia

Uso académico. Consultar a los autores para otros usos.
