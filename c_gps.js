#!/usr/bin/env node

/**
 * MV77G GPS Tracker Server for Railway.com
 * Receives and processes GPS data from MiCODUS MV77G devices
 */

import net from 'net';
import express from 'express';

class MV77GServer {
    constructor() {
        // Railway provides PORT environment variable
        this.tcpPort = process.env.GPS_PORT || 7700;
        this.httpPort = 3000 || process.env.PORT; // Railway requires HTTP server on PORT
        this.host = '0.0.0.0';
        
        this.tcpServer = null;
        this.clients = new Map();
        this.locations = []; // Store in memory (Railway has ephemeral filesystem)
        this.alarms = [];
        this.running = false;
        
        console.log(`🌐 Environment: Railway.com`);
        console.log(`📡 TCP Port: ${this.tcpPort}`);
        console.log(`🌍 HTTP Port: ${this.httpPort}`);
    }

    async start() {
        // Start HTTP server first (Railway requirement)
        await this.startHTTPServer();
        
        // Start TCP server for GPS data
        await this.startTCPServer();
    }

    async startHTTPServer() {
        const app = express();
        
        // Health check endpoint (required by Railway)
        app.get('/', (req, res) => {
            res.json({
                status: 'running',
                service: 'MV77G GPS Tracker',
                timestamp: new Date().toISOString(),
                devices: this.clients.size,
                locations: this.locations.length
            });
        });

        // Get latest location
        app.get('/latest', (req, res) => {
            const latest = this.locations.length > 0 ? this.locations[this.locations.length - 1] : null;
            res.json(latest || { message: 'No GPS data received yet' });
        });

        // Get all locations (limit to last 100 for memory efficiency)
        app.get('/locations', (req, res) => {
            const limit = parseInt(req.query.limit) || 100;
            res.json(this.locations.slice(-limit));
        });

        // Get device-specific locations
        app.get('/device/:deviceId', (req, res) => {
            const deviceId = req.params.deviceId;
            const deviceLocations = this.locations.filter(loc => loc.deviceId === deviceId);
            const limit = parseInt(req.query.limit) || 100;
            res.json(deviceLocations.slice(-limit));
        });

        // Get alarms
        app.get('/alarms', (req, res) => {
            res.json(this.alarms);
        });

        // Clear data endpoint
        app.post('/clear', (req, res) => {
            this.locations = [];
            this.alarms = [];
            res.json({ message: 'Data cleared' });
        });

        return new Promise((resolve) => {
            app.listen(this.httpPort, () => {
                console.log(`✅ HTTP Server running on port ${this.httpPort}`);
                resolve();
            });
        });
    }

    async startTCPServer() {
        return new Promise((resolve, reject) => {
            this.tcpServer = net.createServer((socket) => {
                this.handleGPSClient(socket);
            });

            this.tcpServer.listen(this.tcpPort, this.host, (err) => {
                if (err) {
                    console.error('❌ Failed to start TCP server:', err);
                    reject(err);
                    return;
                }
                
                this.running = true;
                console.log(`✅ GPS TCP Server listening on ${this.host}:${this.tcpPort}`);
                console.log(`📱 Configure your MV77G to connect to: ${process.env.RAILWAY_PUBLIC_DOMAIN || 'your-railway-domain'}:${this.tcpPort}`);
                resolve();
            });

            this.tcpServer.on('error', (err) => {
                console.error('❌ TCP Server error:', err);
            });
        });
    }

    handleGPSClient(socket) {
        const clientAddr = `${socket.remoteAddress}:${socket.remotePort}`;
        console.log(`🔗 GPS device connected: ${clientAddr}`);

        socket.on('data', (data) => {
            try {
                console.log(`📦 Data from ${clientAddr}: ${data.toString('hex')}`);
                this.processGPSMessage(data, clientAddr, socket);
            } catch (error) {
                console.error(`❌ Error processing data from ${clientAddr}:`, error);
            }
        });

        socket.on('close', () => {
            console.log(`❌ GPS device disconnected: ${clientAddr}`);
        });

        socket.on('error', (err) => {
            console.error(`❌ Socket error for ${clientAddr}:`, err);
        });
    }

    processGPSMessage(data, addr, socket) {
        if (data.length < 8) return;

        // Check for start bits 0x7878
        const startBits = data.readUInt16BE(0);
        if (startBits !== 0x7878) {
            console.log(`⚠️  Invalid start bits from ${addr}: 0x${startBits.toString(16)}`);
            return;
        }

        const length = data[2];
        const protocolNumber = data[3];
        const messageType = data[4];

        console.log(`📨 Message type: 0x${messageType.toString(16)} from ${addr}`);

        switch (messageType) {
            case 0x01: // Login
                this.handleLogin(data, addr, socket, protocolNumber);
                break;
            case 0x12: // Location data
                this.handleLocationData(data, addr, protocolNumber);
                break;
            case 0x13: // Heartbeat
                this.handleHeartbeat(data, addr, socket, protocolNumber);
                break;
            case 0x16: // Alarm
                this.handleAlarm(data, addr, protocolNumber);
                break;
            default:
                console.log(`❓ Unknown message type: 0x${messageType.toString(16)}`);
        }
    }

    handleLogin(data, addr, socket, protocolNumber) {
        try {
            // Extract device IMEI (8 bytes after message type)
            const deviceId = data.slice(5, 13).toString('hex');
            
            console.log(`✅ Device login: ${deviceId} from ${addr}`);
            
            this.clients.set(deviceId, {
                address: addr,
                socket: socket,
                lastSeen: new Date(),
                deviceId: deviceId
            });

            // Send login ACK
            const response = Buffer.from([0x78, 0x78, 0x05, protocolNumber, 0x01, 0x00, 0x01, 0x0D, 0x0A]);
            socket.write(response);
            
            console.log(`📤 Login ACK sent to ${deviceId}`);
            
        } catch (error) {
            console.error('❌ Login error:', error);
        }
    }

    handleLocationData(data, addr, protocolNumber) {
        try {
            const locationInfo = this.parseLocationData(data);
            
            if (locationInfo) {
                console.log(`📍 GPS Data Received:`);
                console.log(`   Device: ${locationInfo.deviceId}`);
                console.log(`   Location: ${locationInfo.latitude}, ${locationInfo.longitude}`);
                console.log(`   Speed: ${locationInfo.speed} km/h`);
                console.log(`   Time: ${locationInfo.timestamp}`);
                console.log(`   Satellites: ${locationInfo.satellites}`);
                
                // Store in memory
                this.locations.push(locationInfo);
                
                // Keep only last 1000 locations to manage memory
                if (this.locations.length > 1000) {
                    this.locations = this.locations.slice(-1000);
                }

                // Custom processing - add your logic here
                this.onLocationReceived(locationInfo);
            }
            
        } catch (error) {
            console.error('❌ Location data error:', error);
        }
    }

    handleHeartbeat(data, addr, socket, protocolNumber) {
        console.log(`💓 Heartbeat from ${addr}`);
        
        // Send heartbeat ACK
        const response = Buffer.from([0x78, 0x78, 0x05, protocolNumber, 0x13, 0x00, 0x01, 0x0D, 0x0A]);
        socket.write(response);
    }

    handleAlarm(data, addr, protocolNumber) {
        try {
            const alarmInfo = this.parseLocationData(data);
            if (alarmInfo) {
                alarmInfo.isAlarm = true;
                alarmInfo.alarmType = this.getAlarmType(data[4]);
                
                console.log(`🚨 ALARM: ${alarmInfo.alarmType}`);
                console.log(`   Device: ${alarmInfo.deviceId}`);
                console.log(`   Location: ${alarmInfo.latitude}, ${alarmInfo.longitude}`);
                
                this.alarms.push(alarmInfo);
                
                // Keep only last 100 alarms
                if (this.alarms.length > 100) {
                    this.alarms = this.alarms.slice(-100);
                }

                this.onAlarmReceived(alarmInfo);
            }
        } catch (error) {
            console.error('❌ Alarm handling error:', error);
        }
    }

    parseLocationData(data) {
        try {
            if (data.length < 25) return null;

            // Extract device ID
            const deviceId = data.slice(5, 13).toString('hex');

            // Parse timestamp (6 bytes)
            const year = 2000 + data[13];
            const month = data[14];
            const day = data[15];
            const hour = data[16];
            const minute = data[17];
            const second = data[18];
            
            const timestamp = new Date(year, month - 1, day, hour, minute, second);

            // GPS info byte
            const gpsInfo = data[19];
            const satellites = (gpsInfo >> 4) & 0x0F;

            // Latitude (4 bytes)
            const latBytes = data.readUInt32BE(20);
            let latitude = latBytes / 1800000.0;

            // Longitude (4 bytes) 
            const lonBytes = data.readUInt32BE(24);
            let longitude = lonBytes / 1800000.0;

            // Speed
            const speed = data[28];

            // Course and direction flags
            const courseAndFlags = data.readUInt16BE(29);
            const course = courseAndFlags & 0x03FF; // Last 10 bits
            
            // Direction flags
            if (!(courseAndFlags & 0x0800)) latitude = -latitude; // South
            if (courseAndFlags & 0x0400) longitude = -longitude;  // West

            return {
                deviceId,
                timestamp: timestamp.toISOString(),
                latitude: parseFloat(latitude.toFixed(6)),
                longitude: parseFloat(longitude.toFixed(6)),
                speed,
                course: parseFloat((course / 100.0).toFixed(2)),
                satellites,
                gpsValid: satellites > 0,
                receivedAt: new Date().toISOString()
            };

        } catch (error) {
            console.error('❌ Parse error:', error);
            return null;
        }
    }

    getAlarmType(messageType) {
        const types = {
            0x16: 'SOS Emergency',
            0x19: 'Low Battery',
            0x1A: 'Vibration',
            0x1B: 'Movement',
            0x1C: 'Geo-fence'
        };
        return types[messageType] || `Unknown (0x${messageType.toString(16)})`;
    }

    // Custom callbacks - modify these for your needs
    onLocationReceived(locationData) {
        // Add your custom logic here:
        // - Send to external API
        // - Store in database
        // - Send notifications
        // - Trigger webhooks
        
        console.log(`🎯 Processing location for device ${locationData.deviceId}`);
        
        // Example: Log to external service
        // await this.sendToExternalAPI(locationData);
    }

    onAlarmReceived(alarmData) {
        // Handle alarm/emergency situations
        console.log(`🚨 EMERGENCY ALERT: ${alarmData.alarmType}`);
        
        // Example: Send emergency notification
        // await this.sendEmergencyNotification(alarmData);
    }

    // Utility method for external API integration
    async sendToExternalAPI(data) {
        // Example implementation
        /*
        try {
            const response = await fetch('https://your-api.com/gps', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            console.log('📤 Data sent to external API');
        } catch (error) {
            console.error('❌ External API error:', error);
        }
        */
    }
}

// Railway-specific setup
const server = new MV77GServer();

// Start the server
server.start().then(() => {
    console.log('\n🚀 MV77G GPS Server ready on Railway!');
    console.log('\n📋 Configuration for your MV77G device:');
    console.log('='.repeat(50));
    
    // Railway provides RAILWAY_PUBLIC_DOMAIN or generate from project
    const domain = process.env.RAILWAY_PUBLIC_DOMAIN || 'your-app-name.railway.app';
    
    console.log(`📱 SMS Commands (send to your MV77G SIM number):`);
    console.log(`   APN123456 your_carrier_apn`);
    console.log(`   SERVER123456 ${domain} ${server.tcpPort}`);
    console.log(`   TIMER123456 30`);
    console.log(`   GPRS123456`);
    
    console.log(`\n🌐 API Endpoints:`);
    console.log(`   https://${domain}/latest`);
    console.log(`   https://${domain}/locations`);
    console.log(`   https://${domain}/device/[deviceId]`);
    console.log(`   https://${domain}/alarms`);
    
    console.log('\n✨ Server is running and ready to receive GPS data!');
    
}).catch(error => {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM, shutting down gracefully...');
    server.running = false;
    if (server.tcpServer) server.tcpServer.close();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('🛑 Received SIGINT, shutting down gracefully...');
    server.running = false;
    if (server.tcpServer) server.tcpServer.close();
    process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

/*
RAILWAY DEPLOYMENT FILES:

1. package.json:
{
  "name": "mv77g-gps-server",
  "version": "1.0.0",
  "description": "MV77G GPS tracker server for Railway",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.18.2"
  },
  "engines": {
    "node": ">=16.0.0"
  }
}

2. railway.json (optional):
{
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "npm start"
  }
}

3. Procfile (optional):
web: node server.js

DEPLOYMENT STEPS:

1. Create new Railway project: https://railway.app
2. Connect your GitHub repo or upload files
3. Railway will auto-detect Node.js and deploy
4. Note your Railway domain (e.g., yourapp.railway.app)
5. Configure MV77G with SMS commands using your Railway domain

ENVIRONMENT VARIABLES (set in Railway dashboard):
- GPS_PORT: 5023 (TCP port for GPS data)
- Any custom variables for your external APIs

MV77G CONFIGURATION:
Send these SMS to your device SIM card:
- APN123456 your_carrier_apn
- SERVER123456 your-app.railway.app 5023
- TIMER123456 30
- GPRS123456

MONITORING:
- Check Railway logs for incoming GPS data
- Access https://your-app.railway.app/latest for latest location
- All data is stored in memory (Railway has ephemeral storage)

COMMON APNs:
- T-Mobile: epc.tmobile.com
- AT&T: phone  
- Verizon: vzwinternet
- Check with your carrier for correct APN
*/
