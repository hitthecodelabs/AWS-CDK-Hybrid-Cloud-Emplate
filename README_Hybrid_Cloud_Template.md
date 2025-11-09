# AWS CDK — Hybrid Cloud Template (VPC + EC2 + VPN S2S + RDS opcional + Route53 opcional)

Plantilla de **AWS CDK v2** para desplegar una arquitectura web común y **reutilizable por cliente**, con foco en escenarios **híbridos**:
- VPC con subredes públicas/privadas y **VPN Site‑to‑Site** (VGW + CGW + conexión).
- EC2 con **IP elástica** y **grupos de seguridad mínimos**.
- **RDS MariaDB** (opcional) con credenciales en **AWS Secrets Manager**.
- **Route 53** (opcional) para crear registros **A** apuntando al EIP.

> **Cero secretos en código**: toda la data sensible se inyecta vía **variables de entorno** usando un archivo `.env` (no versionado).

---

## 🧱 Arquitectura desplegada

**Red (VPC)**
- VPC en 2 AZs, con `natGateways` configurable.
- Subredes **públicas** (web) y **privadas con egress** (data/backend).
- **Virtual Private Gateway (VGW)** para la VPN Site‑to‑Site.
- **Propagación de rutas** desde la VPN a las tablas de ruteo públicas y privadas.

**Cómputo (EC2)**
- Instancia Amazon Linux 2 en subred pública (sin public IP directa).
- **Elastic IP (EIP)** asociado a la instancia.
- **Security Group** con:
  - Ingress: **HTTP (80)**, **HTTPS (443)** abiertos; **SSH (22)** restringido a tu IP.
  - Egress explícitos: **DNS(53/udp)**, **HTTP(80)**, **HTTPS(443)**, **ICMP**.
  - Egress opcional a **SAP/API** on‑prem según `.env`.

**Conectividad (VPN Site‑to‑Site)**
- **Customer Gateway (CGW)** representando tu firewall on‑prem (Sophos/Azure/etc.).
- **VPNConnection** (IPsec IKEv2, AES256/SHA2‑256/DH14).
- **Ruta estática** hacia tu red remota (`REMOTE_NETWORK_CIDR`).

**Base de datos (RDS – opcional)**
- **MariaDB 10.6** en subred privada.
- SG que **solo** permite 3306 desde el SG del WebServer.
- Credenciales en **Secrets Manager** (usuario admin generado).

**DNS (Route 53 – opcional)**
- Lookup de **Hosted Zone** por dominio raíz.
- Registros **A** en **apex (@)** y **www** apuntando al **EIP**.

---

## ✅ Prerrequisitos

- Cuenta de AWS con permisos para crear VPC/EC2/RDS/VPN/Route53/Secrets.
- **AWS CLI** configurado: `aws configure`
- **Node.js** 16+
- **AWS CDK v2**: `npm i -g aws-cdk`
- (Recomendado) **Cuenta y región bootstrapped**: `cdk bootstrap`

---

## 📦 Instalación

```bash
git clone https://github.com/hitthecodelabs/AWS-CDK-Hybrid-Cloud-Template.git
cd AWS-CDK-Hybrid-Cloud-Template
npm install
```

> La plantilla usa `dotenv`. No necesitas instalarlo manualmente, viene en `package.json`.

---

## 🔒 Configuración por `.env`

Crea tu archivo `.env` desde el ejemplo y edítalo:

```bash
cp .env.example .env
```

### `.env.example`
```env
# ==============
# Red / VPC
# ==============
NAT_GATEWAYS=1
EC2_INSTANCE_TYPE=t3.medium

# ==============
# Seguridad / Acceso
# ==============
SSH_ALLOWED_IP=
EC2_KEY_PAIR_NAME=my-keypair

# ==============
# Integraciones opcionales (egress a SAP/API on-prem)
# ==============
SAP_API_HOST_IP=
SAP_API_PORT=50000

# ==============
# VPN Site-to-Site
# ==============
CGW_PUBLIC_IP=
CGW_BGP_ASN=65000
VPN_PRESHARED_KEY=change-me
REMOTE_NETWORK_CIDR=

# ==============
# Base de datos (RDS)
# ==============
ENABLE_RDS=true
DB_NAME=appdb
DB_ADMIN_USER=dbadmin
# Si quieres conservar instancias/backups en producción:
DB_RETAIN=false

# ==============
# DNS (Route 53)
# ==============
ENABLE_ROUTE53=false
HOSTED_ZONE_DOMAIN=example.com
CREATE_APEX_A_RECORD=true
CREATE_WWW_A_RECORD=true
```

> ⚠️ **No** subas `.env` al repo. Agrega `/.env` a tu `.gitignore`.

---

## 🚀 Despliegue

1) (Solo la primera vez por cuenta/región)
```bash
cdk bootstrap
```

2) **Deploy** (puedes pasar contexto, p. ej. `-c env=prod`)
```bash
cdk deploy
```

Al finalizar verás los **Outputs** en consola.

---

## 📤 Outputs del Stack

- **VpcId** — ID de la VPC creada.
- **PublicElasticIp** — EIP pública asociada al WebServer.
- **WebServerInstanceId** — ID de la instancia EC2.
- **WebServerSecurityGroupId** — ID del SG del WebServer.
- **CustomerGatewayId** — ID del Customer Gateway.
- **VpnConnectionId** — ID de la conexión VPN.

Si `ENABLE_RDS=true`:
- **DBEndpointAddress** — Endpoint de RDS MariaDB.
- **DBSecretName** — Nombre del secreto con credenciales en Secrets Manager.

Si `ENABLE_ROUTE53=true` y configurado el dominio:
- **ApexARecord** / **WwwARecord** (según flags) apuntando al EIP.

---

## 🧰 Scripts útiles

```bash
# Sintetizar la CloudFormation sin desplegar
npm run synth

# Ver diferencias contra el estado actual
npm run diff

# Desplegar
npm run deploy

# Destruir (¡irreversible! verifica tus RETAIN flags antes)
npm run destroy
```

> Estos scripts esperan que tengas Node 16+ y CDK v2 global. Ajusta en `package.json` si prefieres `npx cdk`.

---

## 💡 Buenas prácticas y notas

- **Seguridad SSH**: deja `SSH_ALLOWED_IP` con tu /32 real; evita `0.0.0.0/0`.
- **HTTPS**: el SG ya abre **443**; emite/instala tu certificado (ACM + ALB *o* cert manejado en EC2/Apache/Nginx).
- **Costos**: EIP, RDS y VPN generan costos. En ambientes efímeros, considera `DB_RETAIN=false` y `ENABLE_RDS=false`.
- **Route 53**: si habilitas DNS, asegúrate de tener la **Hosted Zone** en la misma cuenta y dominio válidos.
- **VPN**: la conexión sale **estática**. Si prefieres BGP dinámico, adapta `staticRoutesOnly=false` y la config del on‑prem.

---

## 🧽 Limpieza

Para liberar recursos (¡cuidado con datos persistentes!):
```bash
cdk destroy
```
Asegúrate de haber respaldado la información si usaste `DB_RETAIN=false`.

---

## 📁 Estructura mínima

```
.
├─ bin/
├─ lib/
│  └─ jordan-aws-stack.ts   # stack principal (parametrizado por .env)
├─ package.json
├─ cdk.json
├─ .env.example
└─ README.md
```

---

## © Licencia

MIT — Úsalo como base y modíficalo según tus necesidades.
