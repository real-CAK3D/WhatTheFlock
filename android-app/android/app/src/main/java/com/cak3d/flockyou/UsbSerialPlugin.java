package com.cak3d.flockyou;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.util.Base64;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * USB CDC-ACM serial for the XIAO ESP32-S3 (Espressif USB Serial/JTAG),
 * the native stand-in for WebUSB, which Android's WebView doesn't have.
 *
 * JS: list(), open({vendorId}), write({data: base64}), close();
 * events "data" {data: base64}, "attached" / "detached" {vendorId, productId}.
 * Reading runs on its own thread, so it keeps going with the screen off
 * (the background-location foreground service keeps the process alive).
 */
@CapacitorPlugin(name = "UsbSerial")
public class UsbSerialPlugin extends Plugin {
    private static final String ACTION_PERMISSION = "com.cak3d.flockyou.USB_PERMISSION";

    private UsbManager manager;
    private UsbDevice device;
    private UsbDeviceConnection conn;
    private UsbInterface ctrlIf, dataIf;
    private UsbEndpoint epIn, epOut;
    private Thread reader;
    private volatile boolean running;
    private PluginCall pendingOpen;

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            String action = intent.getAction();
            UsbDevice d = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
            if (ACTION_PERMISSION.equals(action)) {
                boolean granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
                PluginCall call = pendingOpen;
                pendingOpen = null;
                if (call == null) return;
                if (granted && d != null) doOpen(call, d);
                else call.reject("USB permission denied");
            } else if (UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(action) && d != null) {
                notifyListeners("attached", info(d));
            } else if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(action) && d != null) {
                if (device != null && d.getDeviceName().equals(device.getDeviceName())) shutdown();
                notifyListeners("detached", info(d));
            }
        }
    };

    @Override
    public void load() {
        manager = (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
        IntentFilter f = new IntentFilter();
        f.addAction(ACTION_PERMISSION);
        f.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        f.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        ContextCompat.registerReceiver(getContext(), receiver, f, ContextCompat.RECEIVER_EXPORTED);
    }

    // The activity is (re)launched by the USB_DEVICE_ATTACHED intent filter when the board is plugged in.
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(intent.getAction())) {
            UsbDevice d = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
            if (d != null) notifyListeners("attached", info(d));
        }
    }

    private JSObject info(UsbDevice d) {
        JSObject o = new JSObject();
        o.put("vendorId", d.getVendorId());
        o.put("productId", d.getProductId());
        o.put("deviceName", d.getDeviceName());
        o.put("hasPermission", manager.hasPermission(d));
        return o;
    }

    private UsbDevice find(int vendorId) {
        for (UsbDevice d : manager.getDeviceList().values()) if (vendorId == 0 || d.getVendorId() == vendorId) return d;
        return null;
    }

    @PluginMethod
    public void list(PluginCall call) {
        JSArray arr = new JSArray();
        for (UsbDevice d : manager.getDeviceList().values()) arr.put(info(d));
        JSObject r = new JSObject();
        r.put("devices", arr);
        call.resolve(r);
    }

    @PluginMethod
    public void open(PluginCall call) {
        int vid = call.getInt("vendorId", 0);
        UsbDevice d = find(vid);
        if (d == null) { call.reject("Board not found — is it plugged in?"); return; }
        if (conn != null && device != null && d.getDeviceName().equals(device.getDeviceName())) { call.resolve(info(d)); return; }
        if (manager.hasPermission(d)) { doOpen(call, d); return; }
        pendingOpen = call;
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0;
        Intent i = new Intent(ACTION_PERMISSION).setPackage(getContext().getPackageName());
        manager.requestPermission(d, PendingIntent.getBroadcast(getContext(), 0, i, flags));
    }

    private void doOpen(PluginCall call, UsbDevice d) {
        shutdown();
        UsbDeviceConnection c = manager.openDevice(d);
        if (c == null) { call.reject("Could not open the board"); return; }
        UsbInterface cif = null, dif = null;
        UsbEndpoint in = null, out = null;
        for (int i = 0; i < d.getInterfaceCount(); i++) {
            UsbInterface itf = d.getInterface(i);
            if (itf.getInterfaceClass() == UsbConstants.USB_CLASS_COMM && cif == null) cif = itf;
            if (itf.getInterfaceClass() == UsbConstants.USB_CLASS_CDC_DATA && dif == null) {
                dif = itf;
                for (int e = 0; e < itf.getEndpointCount(); e++) {
                    UsbEndpoint ep = itf.getEndpoint(e);
                    if (ep.getType() != UsbConstants.USB_ENDPOINT_XFER_BULK) continue;
                    if (ep.getDirection() == UsbConstants.USB_DIR_IN) in = ep; else out = ep;
                }
            }
        }
        if (dif == null || in == null || out == null) { c.close(); call.reject("Not a USB serial device"); return; }
        if (cif != null) c.claimInterface(cif, true);
        c.claimInterface(dif, true);
        int ctrlIndex = cif != null ? cif.getId() : dif.getId();
        // SET_LINE_CODING 115200 8N1, then SET_CONTROL_LINE_STATE DTR=1 RTS=0.
        // (Other DTR/RTS combinations drive the ESP32-S3's reset/boot lines.)
        byte[] lc = { 0x00, (byte) 0xC2, 0x01, 0x00, 0x00, 0x00, 0x08 };
        c.controlTransfer(0x21, 0x20, 0, ctrlIndex, lc, lc.length, 1000);
        c.controlTransfer(0x21, 0x22, 0x01, ctrlIndex, null, 0, 1000);
        device = d; conn = c; ctrlIf = cif; dataIf = dif; epIn = in; epOut = out;
        startReader();
        call.resolve(info(d));
    }

    private void startReader() {
        running = true;
        final UsbDeviceConnection c = conn;
        final UsbEndpoint in = epIn;
        reader = new Thread(() -> {
            byte[] buf = new byte[Math.max(512, in.getMaxPacketSize())];
            while (running) {
                int n = c.bulkTransfer(in, buf, buf.length, 250);
                if (n > 0) {
                    JSObject o = new JSObject();
                    o.put("data", Base64.encodeToString(buf, 0, n, Base64.NO_WRAP));
                    notifyListeners("data", o);
                }
            }
        }, "usb-serial-reader");
        reader.start();
    }

    @PluginMethod
    public void write(PluginCall call) {
        if (conn == null) { call.reject("Board not connected"); return; }
        byte[] bytes = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
        int off = 0;
        while (off < bytes.length) {
            int len = Math.min(16384, bytes.length - off);
            byte[] part = new byte[len];
            System.arraycopy(bytes, off, part, 0, len);
            int n = conn.bulkTransfer(epOut, part, len, 2000);
            if (n < 0) { call.reject("Write failed"); return; }
            off += n;
        }
        call.resolve();
    }

    @PluginMethod
    public void close(PluginCall call) {
        shutdown();
        call.resolve();
    }

    private synchronized void shutdown() {
        running = false;
        if (reader != null) { try { reader.join(500); } catch (InterruptedException ignored) { } reader = null; }
        if (conn != null) {
            try { if (dataIf != null) conn.releaseInterface(dataIf); if (ctrlIf != null) conn.releaseInterface(ctrlIf); } catch (Exception ignored) { }
            conn.close();
        }
        conn = null; device = null; epIn = null; epOut = null; ctrlIf = null; dataIf = null;
    }

    @Override
    protected void handleOnDestroy() {
        shutdown();
        try { getContext().unregisterReceiver(receiver); } catch (Exception ignored) { }
    }
}
