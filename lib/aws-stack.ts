// lib/aws-stack.ts

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';

// 1. Importar y configurar dotenv para cargar las variables de entorno del archivo .env
import * as dotenv from 'dotenv';
dotenv.config();

export class JordanAwsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // =================================================================
    // 1. DEFINIR NUESTRA RED PRIVADA (VPC)
    // =================================================================
    const vpc = new ec2.Vpc(this, 'HybridCloudVPC', {
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
      vpnGateway: true,
    });

    // =================================================================
    // 1.5. CREAR UNA IP PÚBLICA ESTÁTICA (ELASTIC IP)
    // =================================================================
    const elasticIp = new ec2.CfnEIP(this, 'WebServerElasticIp');

    // =================================================================
    // 2. DEFINIR NUESTRO FIREWALL (GRUPO DE SEGURIDAD DEL SERVIDOR WEB)
    // =================================================================
    const webServerSecurityGroup = new ec2.SecurityGroup(this, 'WebServerSecurityGroup', {
      vpc,
      description: 'Permite trafico HTTP y SSH',
      allowAllOutbound: true,
    });
    webServerSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Permitir acceso HTTP desde internet');
    
    // --> DATO SENSIBLE EXTERNALIZADO
    webServerSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(process.env.SSH_ALLOWED_IP!), 
      ec2.Port.tcp(22), 
      'Permitir acceso SSH solo desde la IP definida en .env'
    );

    // =================================================================
    // 3. DEFINIR NUESTRO SERVIDOR (INSTANCIA EC2)
    // =================================================================
    const ec2Instance = new ec2.Instance(this, 'WebServer', {
      vpc,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MEDIUM
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2(),
      securityGroup: webServerSecurityGroup,
      // --> DATO SENSIBLE EXTERNALIZADO (se recomienda usar keyPair en lugar de keyName)
      keyName: process.env.EC2_KEY_PAIR_NAME!, 
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      associatePublicIpAddress: false, 
    });

    // =================================================================
    // 3.5. ASOCIAR LA IP ELÁSTICA A LA INSTANCIA EC2
    // =================================================================
    new ec2.CfnEIPAssociation(this, 'EIPAssociation', {
      eip: elasticIp.ref,
      instanceId: ec2Instance.instanceId,
    });

    // =================================================================
    // 4. MOSTRAR LA IP PÚBLICA AL FINALIZAR
    // =================================================================
    new cdk.CfnOutput(this, 'PublicIPAddress', { value: elasticIp.ref, description: 'IP Pública ESTÁTICA del Servidor Web' });

    // =================================================================
    // 5. CONFIGURACIÓN VPN SITE-TO-SITE
    // =================================================================
    
    // 5.1. Crear el Customer Gateway (Representa el firewall on-premise)
    const customerGateway = new ec2.CfnCustomerGateway(this, 'OnPremiseCustomerGateway', {
      type: 'ipsec.1',
      // --> DATO SENSIBLE EXTERNALIZADO
      ipAddress: process.env.ONPREM_PUBLIC_IP!,
      bgpAsn: 65000,
    });

    // 5.2. Crear la Conexión VPN con parámetros detallados
    const vpnConnection = new ec2.CfnVPNConnection(this, 'SiteToSiteVpnConnection', {
      customerGatewayId: customerGateway.ref,
      type: 'ipsec.1',
      vpnGatewayId: vpc.vpnGatewayId!,
      staticRoutesOnly: true,
      
      vpnTunnelOptionsSpecifications: [
        {
          // --> DATO SENSIBLE EXTERNALIZADO
          preSharedKey: process.env.VPN_PRESHARED_KEY!,
          tunnelInsideCidr: '',
          ikeVersions: [{ value: 'ikev2' }],
          phase1EncryptionAlgorithms: [{ value: 'AES256' }],
          phase1IntegrityAlgorithms: [{ value: 'SHA2-256' }],
          phase1DhGroupNumbers: [{ value: 14 }],
          phase1LifetimeSeconds: 28800,
        },
        {
          // --> DATO SENSIBLE EXTERNALIZADO
          preSharedKey: process.env.VPN_PRESHARED_KEY!,
          tunnelInsideCidr: '',
          phase2EncryptionAlgorithms: [{ value: 'AES256' }],
          phase2IntegrityAlgorithms: [{ value: 'SHA2-256' }],
          phase2DhGroupNumbers: [{ value: 14 }],
          phase2LifetimeSeconds: 3600,
        }
      ]
    });

    // 5.3. Añadir la ruta estática hacia la red on-premise
    new ec2.CfnVPNConnectionRoute(this, 'ToOnPremiseStaticRoute', {
      // --> DATO SENSIBLE EXTERNALIZADO
      destinationCidrBlock: process.env.ONPREM_LOCAL_SUBNET!,
      vpnConnectionId: vpnConnection.ref,
    });

    // =================================================================
    // 6. CREAR EL FIREWALL PARA LA BASE DE DATOS
    // =================================================================
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', { vpc, description: 'Permite el acceso a la base de datos desde el servidor web' });
    dbSecurityGroup.addIngressRule(webServerSecurityGroup, ec2.Port.tcp(3306), 'Allow MariaDB access from WebServer');

    // =================================================================
    // 7. CREAR LA INSTANCIA DE BASE DE DATOS RDS
    // =================================================================
    const dbInstance = new rds.DatabaseInstance(this, 'MariaDBInstance', {
        engine: rds.DatabaseInstanceEngine.mariaDb({ version: rds.MariaDbEngineVersion.VER_10_6 }),
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [dbSecurityGroup],
        databaseName: 'pos',
        credentials: rds.Credentials.fromGeneratedSecret('dbadmin'), 
        allocatedStorage: 20,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // =================================================================
    // 8. MOSTRAR LA INFORMACIÓN DE LA BASE DE DATOS AL FINALIZAR
    // =================================================================
    new cdk.CfnOutput(this, 'DBEndpointAddress', { value: dbInstance.dbInstanceEndpointAddress, description: 'Endpoint de la Base de Datos RDS' });
    new cdk.CfnOutput(this, 'DBSecretName', { value: dbInstance.secret?.secretName || 'No Secret Name', description: 'Nombre del secreto en AWS Secrets Manager para las credenciales de la DB' });
  }
}
