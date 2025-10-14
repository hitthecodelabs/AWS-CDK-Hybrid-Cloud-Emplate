# AWS-CDK-Hybrid-Cloud-Emplate

Este repositorio es una plantilla de AWS CDK para desplegar una arquitectura web común en AWS, incluyendo una conexión VPN Site-to-Site para establecer un entorno de nube híbrida. La infraestructura es ideal para laboratorios, pruebas de concepto o como base para proyectos más complejos.

Toda la configuración sensible (IPs, claves, subredes) se gestiona a través de variables de entorno para garantizar que el código del repositorio permanezca genérico y seguro.

---

## Arquitectura Desplegada

Este stack de CDK crea los siguientes recursos en AWS:

- **Red (VPC):**
  - Una VPC con 2 Zonas de Disponibilidad para alta resiliencia.
  - Subredes públicas para recursos de cara a internet (como el servidor web).
  - Subredes privadas para recursos de backend (como la base de datos).
  - Un Virtual Private Gateway para la conexión VPN.

- **Cómputo (EC2):**
  - Una instancia EC2 (Amazon Linux 2) en una subred pública.
  - Un Grupo de Seguridad que permite tráfico HTTP (puerto 80) y SSH (puerto 22) desde una IP específica.
  - Una IP Elástica asociada a la instancia para tener una dirección IP pública fija.

- **Base de Datos (RDS):**
  - Una instancia de base de datos MariaDB en una subred privada para máxima seguridad.
  - Un Grupo de Seguridad que solo permite conexiones desde el servidor web.
  - Las credenciales se gestionan de forma segura a través de AWS Secrets Manager.

- **Conectividad (VPN):**
  - Un Customer Gateway que representa el firewall local (ej. Sophos).
  - Una Conexión VPN Site-to-Site con parámetros de encriptación seguros (AES256, SHA2-256, DH Group 14).
  - Una ruta estática para dirigir el tráfico desde la VPC hacia la red local a través del túnel VPN.

---

## Prerrequisitos

Antes de empezar, asegúrate de tener instalado y configurado lo siguiente:
- Cuenta de AWS
- AWS CLI (`aws configure`)
- Node.js (v16 o superior)
- AWS CDK (`npm install -g aws-cdk`)

---

## 🚀 Guía de Despliegue

**1. Clonar el Repositorio:**
```bash
git clone https://github.com/hitthecodelabs/AWS-CDK-Hybrid-Cloud-Emplate
cd cdk-hybrid-cloud-template
```


**2. Instalar Dependencias:**
```bash
npm install
npm install dotenv
```

**3. Configurar el Entorno:**
Crea un archivo .env a partir de la plantilla. Este archivo contendrá todos tus secretos y no será subido al repositorio.

```bash
cp .env.example .env
```

Ahora, edita el archivo .env y rellena los valores con la información de tu entorno:

```env
# .env - Rellena estos valores
SSH_ALLOWED_IP=TU_IP_PUBLICA/32
EC2_KEY_PAIR_NAME=nombre-de-tu-key-pair-en-aws
ONPREM_PUBLIC_IP=ip-publica-de-tu-firewall-sophos
ONPREM_LOCAL_SUBNET=subred-de-tu-red-local
VPN_PRESHARED_KEY=tu-clave-secreta-compatible-con-aws
```

**4. Desplegar el Stack:**
Primero, si es la primera vez que usas CDK en esta región/cuenta, ejecuta `bootstrap`.

```bash
cdk bootstrap
```
Luego, despliega la infraestructura.
```bash
cdk deploy
```

El proceso tardará varios minutos. Al finalizar, verás las salidas (Outputs) en la terminal.
