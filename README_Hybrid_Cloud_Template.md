# AWS CDK — Hybrid Cloud Template (VPC + EC2 + VPN S2S + RDS opcional + Route53 opcional)

Plantilla de **AWS CDK v2** para desplegar una arquitectura web común y **reutilizable por cliente**, con foco en escenarios **híbridos**:
- VPC con subredes públicas/privadas y **VPN Site‑to‑Site** (VGW + CGW + conexión).
- EC2 con **IP elástica** y **grupos de seguridad mínimos**.
- **RDS MariaDB** (opcional) con credenciales en **AWS Secrets Manager**.
- **Route 53** (opcional) para crear registros **A** apuntando al EIP.

> **Cero secretos en código**: toda la data sensible se inyecta vía **variables de entorno** usando un archivo `.env` (no versionado).

