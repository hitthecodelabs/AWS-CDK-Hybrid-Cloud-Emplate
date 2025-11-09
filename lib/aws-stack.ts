// lib/jordan-aws-stack.ts
//
// Plantilla CDK v2 para despliegue híbrido (VPC + EC2 + VPN S2S + RDS opcional + Route53)
// ► Todo configurable vía .env (sin secretos hardcodeados)
// Requisitos de .env (ejemplos):
//   NAT_GATEWAYS=1
//   EC2_INSTANCE_TYPE=
//   SSH_ALLOWED_IP=
//   EC2_KEY_PAIR_NAME=my-keypair
//   SAP_API_HOST_IP=         # opcional
//   SAP_API_PORT=50000                   # opcional
//   CGW_PUBLIC_IP=
//   CGW_BGP_ASN=65000
//   VPN_PRESHARED_KEY=super-psk-value
//   REMOTE_NETWORK_CIDR=
//   ENABLE_RDS=true
//   DB_NAME=appdb
//   DB_ADMIN_USER=dbadmin
//   DB_RETAIN=false
//   ENABLE_ROUTE53=true
//   HOSTED_ZONE_DOMAIN=example.com       # dominio raíz de la zona alojada
//   CREATE_APEX_A_RECORD=true            # A en @
//   CREATE_WWW_A_RECORD=true             # A en www
//
// Notas:
// - No expone secretos; usa Secrets Manager para RDS.
// - Puedes activar/desactivar RDS y Route53 por flags.
// - Ajusta los defaults abajo si lo deseas.


