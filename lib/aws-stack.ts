// lib/jordan-aws-stack.ts
//
// Plantilla CDK v2 para despliegue híbrido (VPC + EC2 + VPN S2S + RDS opcional + Route53)
// ► Todo configurable vía .env (sin secretos hardcodeados)
// Requisitos de .env (ejemplos):
//   NAT_GATEWAYS=1
//   EC2_INSTANCE_TYPE=t3.medium
//   SSH_ALLOWED_IP=203.0.113.10/32
//   EC2_KEY_PAIR_NAME=my-keypair
//   SAP_API_HOST_IP=10.1.0.15/32         # opcional
//   SAP_API_PORT=50000                   # opcional
//   CGW_PUBLIC_IP=198.51.100.20
//   CGW_BGP_ASN=65000
//   VPN_PRESHARED_KEY=super-psk-value
//   REMOTE_NETWORK_CIDR=10.1.0.0/16
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

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as dotenv from 'dotenv';

dotenv.config();

// Helpers de entorno
function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return v;
}
function envBool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'y'].includes(v.toLowerCase());
}
function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}
function parseInstanceType(raw: string): ec2.InstanceType {
  try {
    const [family, size] = raw.split('.');
    return ec2.InstanceType.of(
      ec2.InstanceClass[family.toUpperCase() as keyof typeof ec2.InstanceClass],
      ec2.InstanceSize[size.toUpperCase() as keyof typeof ec2.InstanceSize]
    );
  } catch {
    return ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM);
  }
}

export class JordanAwsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --------------------------------------------------
    // 0) Parámetros generales desde .env
    // --------------------------------------------------
    const NAT_GATEWAYS = envInt('NAT_GATEWAYS', 1);
    const INSTANCE_TYPE = parseInstanceType(process.env.EC2_INSTANCE_TYPE ?? 't3.medium');

    const SSH_ALLOWED_IP = env('SSH_ALLOWED_IP');          // p.ej. "203.0.113.10/32", local computer/laptop/server
    const EC2_KEY_PAIR_NAME = env('EC2_KEY_PAIR_NAME');    // key pair existente

    const SAP_API_HOST_IP = process.env.SAP_API_HOST_IP;   // opcional
    const SAP_API_PORT = envInt('SAP_API_PORT', 50000);    // opcional

    // VPN S2S
    const CGW_PUBLIC_IP = env('CGW_PUBLIC_IP');
    const CGW_BGP_ASN = envInt('CGW_BGP_ASN', 65000);
    const VPN_PSK = env('VPN_PRESHARED_KEY');
    const REMOTE_NETWORK_CIDR = env('REMOTE_NETWORK_CIDR');

    // RDS
    const ENABLE_RDS = envBool('ENABLE_RDS', true);
    const DB_NAME = process.env.DB_NAME ?? 'appdb';
    const DB_ADMIN_USER = process.env.DB_ADMIN_USER ?? 'dbadmin';
    const DB_RETAIN = envBool('DB_RETAIN', false);

    // Route53 / DNS
    const ENABLE_ROUTE53 = envBool('ENABLE_ROUTE53', false);
    const HOSTED_ZONE_DOMAIN = process.env.HOSTED_ZONE_DOMAIN; // requerido si ENABLE_ROUTE53=true
    const CREATE_APEX_A_RECORD = envBool('CREATE_APEX_A_RECORD', true);
    const CREATE_WWW_A_RECORD  = envBool('CREATE_WWW_A_RECORD', true);

    // ==================================================
    // 1) RED — VPC con VGW para VPN (públicas/privadas)
    // ==================================================
    const vpc = new ec2.Vpc(this, 'HybridCloudVPC', {
      maxAzs: 2,
      natGateways: NAT_GATEWAYS,
      subnetConfiguration: [
        { cidrMask: 24, name: 'public',  subnetType: ec2.SubnetType.PUBLIC },
        { cidrMask: 24, name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ],
      vpnGateway: true, // VGW
    });

    // Propagación de rutas de la VPN a tablas de ruteo públicas y privadas
    (vpc.publicSubnets as ec2.Subnet[]).forEach((subnet, idx) => {
      new ec2.CfnVPNGatewayRoutePropagation(this, `VpnPropPublic${idx}`, {
        routeTableIds: [subnet.routeTable.routeTableId],
        vpnGatewayId: vpc.vpnGatewayId!,
      });
    });
    (vpc.privateSubnets as ec2.Subnet[]).forEach((subnet, idx) => {
      new ec2.CfnVPNGatewayRoutePropagation(this, `VpnPropPrivate${idx}`, {
        routeTableIds: [subnet.routeTable.routeTableId],
        vpnGatewayId: vpc.vpnGatewayId!,
      });
    });

    // ==================================================
    // 2) SEGURIDAD — SG del servidor web (EC2)
    // ==================================================
    const webSG = new ec2.SecurityGroup(this, 'WebServerSG', {
      vpc,
      description: 'HTTP/HTTPS públicos, SSH restringido, egress explícito',
      allowAllOutbound: false,
    });

    // Ingress
    webSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80),  'HTTP público');
    webSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS público');
    webSG.addIngressRule(ec2.Peer.ipv4(SSH_ALLOWED_IP), ec2.Port.tcp(22), 'SSH desde IP permitida');

    // Egress (updates y diagnóstico)
    webSG.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(53), 'DNS saliente (UDP 53)');
    webSG.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80),  'HTTP saliente');
    webSG.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS saliente');
    webSG.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.allIcmp(), 'ICMP saliente (ping)');

    // Egress opcional hacia SAP / API interna
    if ((SAP_API_HOST_IP ?? '').trim() !== '') {
      webSG.addEgressRule(ec2.Peer.ipv4(SAP_API_HOST_IP!.trim()), ec2.Port.tcp(SAP_API_PORT), 'Salida a SAP/API');
    }

    // ==================================================
    // 3) CÓMPUTO — EC2 + EIP (IP pública estática)
    // ==================================================
    const webServer = new ec2.Instance(this, 'WebServer', {
      vpc,
      instanceType: INSTANCE_TYPE,
      machineImage: ec2.MachineImage.latestAmazonLinux2(),
      securityGroup: webSG,
      keyName: EC2_KEY_PAIR_NAME,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      associatePublicIpAddress: false, // usaremos EIP
      requireImdsv2: true,
    });

    const eip = new ec2.CfnEIP(this, 'WebServerEip');
    new ec2.CfnEIPAssociation(this, 'WebServerEipAssociation', {
      eip: eip.ref,
      instanceId: webServer.instanceId,
    });

    // ==================================================
    // 4) CONECTIVIDAD — VPN Site-to-Site
    // ==================================================
    const cgw = new ec2.CfnCustomerGateway(this, 'CustomerGateway', {
      type: 'ipsec.1',
      ipAddress: CGW_PUBLIC_IP,
      bgpAsn: CGW_BGP_ASN,
    });

    const vpn = new ec2.CfnVPNConnection(this, 'SiteToSiteVpn', {
      customerGatewayId: cgw.ref,
      type: 'ipsec.1',
      vpnGatewayId: vpc.vpnGatewayId!,
      staticRoutesOnly: true,
      vpnTunnelOptionsSpecifications: [
        {
          preSharedKey: VPN_PSK,
          ikeVersions: [{ value: 'ikev2' }],
          phase1EncryptionAlgorithms: [{ value: 'AES256' }],
          phase1IntegrityAlgorithms: [{ value: 'SHA2-256' }],
          phase1DhGroupNumbers: [{ value: 14 }],
          phase1LifetimeSeconds: 28800,
          phase2EncryptionAlgorithms: [{ value: 'AES256' }],
          phase2IntegrityAlgorithms: [{ value: 'SHA2-256' }],
          phase2DhGroupNumbers: [{ value: 14 }],
          phase2LifetimeSeconds: 3600,
        },
        {
          preSharedKey: VPN_PSK,
          ikeVersions: [{ value: 'ikev2' }],
          phase1EncryptionAlgorithms: [{ value: 'AES256' }],
          phase1IntegrityAlgorithms: [{ value: 'SHA2-256' }],
          phase1DhGroupNumbers: [{ value: 14 }],
          phase1LifetimeSeconds: 28800,
          phase2EncryptionAlgorithms: [{ value: 'AES256' }],
          phase2IntegrityAlgorithms: [{ value: 'SHA2-256' }],
          phase2DhGroupNumbers: [{ value: 14 }],
          phase2LifetimeSeconds: 3600,
        },
      ],
    });

    new ec2.CfnVPNConnectionRoute(this, 'VpnStaticRoute', {
      destinationCidrBlock: REMOTE_NETWORK_CIDR,
      vpnConnectionId: vpn.ref,
    });

    // ==================================================
    // 5) DATOS — RDS MariaDB (opcional)
    // ==================================================
    let dbEndpoint = '';
    let dbSecretName = '';

    if (ENABLE_RDS) {
      const dbSG = new ec2.SecurityGroup(this, 'DbSG', {
        vpc,
        description: 'Acceso MariaDB solo desde WebServer',
      });
      dbSG.addIngressRule(webSG, ec2.Port.tcp(3306), 'MariaDB desde WebServer');

      const db = new rds.DatabaseInstance(this, 'MariaDB', {
        engine: rds.DatabaseInstanceEngine.mariaDb({ version: rds.MariaDbEngineVersion.VER_10_6 }),
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [dbSG],
        databaseName: DB_NAME,
        credentials: rds.Credentials.fromGeneratedSecret(DB_ADMIN_USER),
        allocatedStorage: 20,
        removalPolicy: DB_RETAIN ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        deleteAutomatedBackups: !DB_RETAIN,
        backupRetention: cdk.Duration.days(DB_RETAIN ? 7 : 0),
      });

      dbEndpoint = db.dbInstanceEndpointAddress;
      dbSecretName = db.secret?.secretName ?? '';
    }

    // ==================================================
    // 6) SALIDAS (Outputs) útiles
    // ==================================================
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId, description: 'ID de la VPC' });
    new cdk.CfnOutput(this, 'PublicElasticIp', { value: eip.ref, description: 'EIP pública del WebServer' });
    new cdk.CfnOutput(this, 'WebServerInstanceId', { value: webServer.instanceId, description: 'ID de la instancia EC2' });
    new cdk.CfnOutput(this, 'WebServerSecurityGroupId', { value: webSG.securityGroupId, description: 'ID del SG del WebServer' });
    new cdk.CfnOutput(this, 'CustomerGatewayId', { value: cgw.ref, description: 'ID del Customer Gateway' });
    new cdk.CfnOutput(this, 'VpnConnectionId', { value: vpn.ref, description: 'ID de la conexión VPN' });

    if (ENABLE_RDS) {
      new cdk.CfnOutput(this, 'DBEndpointAddress', { value: dbEndpoint, description: 'Endpoint de RDS' });
      new cdk.CfnOutput(this, 'DBSecretName', { value: dbSecretName || 'No Secret Name', description: 'Nombre del secreto en Secrets Manager' });
    }

    // ==================================================
    // 7) DNS — Route 53 (opcional, por .env)
    // ==================================================
    if (ENABLE_ROUTE53) {
      if (!HOSTED_ZONE_DOMAIN) {
        throw new Error('ENABLE_ROUTE53=true requiere HOSTED_ZONE_DOMAIN en .env');
      }

      // Lookup de la zona alojada por nombre de dominio raíz (ej: example.com)
      const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
        domainName: HOSTED_ZONE_DOMAIN,
      });

      // 8) Registros A — apuntando al EIP
      if (CREATE_APEX_A_RECORD) {
        new route53.ARecord(this, 'ApexARecord', {
          zone: hostedZone,
          recordName: HOSTED_ZONE_DOMAIN, // dominio raíz
          target: route53.RecordTarget.fromIpAddresses(eip.ref),
          ttl: cdk.Duration.minutes(1),
        });
      }

      if (CREATE_WWW_A_RECORD) {
        new route53.ARecord(this, 'WwwARecord', {
          zone: hostedZone,
          recordName: `www.${HOSTED_ZONE_DOMAIN}`,
          target: route53.RecordTarget.fromIpAddresses(eip.ref),
          ttl: cdk.Duration.minutes(1),
        });
      }
    }

    // ==================================================
    // 9) Tags de utilidad (costeo/filtrado)
    // ==================================================
    cdk.Tags.of(this).add('Project', 'Hybrid-Cloud-Template');
    cdk.Tags.of(this).add('Owner', 'OwnerAwsStack');
    cdk.Tags.of(this).add('Environment', this.node.tryGetContext('env') ?? 'dev');
  }
}
