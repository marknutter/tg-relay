/**
 * FaceDetect — single-shot face detection for tg-relay presence.
 *
 * Opens the default camera, captures one frame at low resolution,
 * runs VNDetectFaceRectanglesRequest, prints a JSON result to stdout,
 * then exits (releasing the camera).
 *
 * Build:
 *   swiftc -O -o FaceDetect FaceDetect.swift \
 *     -framework AVFoundation -framework Vision -framework CoreMedia
 *
 * Output (stdout, one line):
 *   {"faceDetected":true,"confidence":0.98,"faceCount":1}
 *   {"faceDetected":false,"confidence":0,"faceCount":0}
 *   {"faceDetected":false,"error":"camera_denied","confidence":0,"faceCount":0}
 *
 * Exit codes:
 *   0  success (face result is valid)
 *   1  error (camera unavailable, denied, timeout, etc.)
 */

import AVFoundation
import Vision
import Foundation

// MARK: - Result output

func printResult(detected: Bool, confidence: Float = 0, faceCount: Int = 0, error: String? = nil) {
    var dict: [String: Any] = [
        "faceDetected": detected,
        "confidence": Double(confidence),
        "faceCount": faceCount,
    ]
    if let error = error {
        dict["error"] = error
    }
    if let data = try? JSONSerialization.data(withJSONObject: dict),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    } else {
        print("{\"faceDetected\":false,\"error\":\"json_encode_failed\"}")
    }
}

// MARK: - Face detector

class FaceDetector: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private let session = AVCaptureSession()
    private var captured = false
    private var resultCode: Int32 = 1

    func run() -> Int32 {
        // ── Camera authorization ────────────────────────────────────────
        let status = AVCaptureDevice.authorizationStatus(for: .video)

        if status == .denied || status == .restricted {
            printResult(detected: false, error: "camera_denied")
            return 1
        }

        // First-run: request permission (shows the macOS dialog).
        if status == .notDetermined {
            let sem = DispatchSemaphore(value: 0)
            var granted = false
            AVCaptureDevice.requestAccess(for: .video) { result in
                granted = result
                sem.signal()
            }
            sem.wait()
            if !granted {
                printResult(detected: false, error: "camera_denied")
                return 1
            }
        }

        // ── Capture setup ───────────────────────────────────────────────
        guard let device = AVCaptureDevice.default(for: .video) else {
            printResult(detected: false, error: "no_camera")
            return 1
        }

        guard let input = try? AVCaptureDeviceInput(device: device) else {
            printResult(detected: false, error: "camera_input_failed")
            return 1
        }

        // Low resolution is sufficient for face detection and saves power.
        session.sessionPreset = .low
        guard session.canAddInput(input) else {
            printResult(detected: false, error: "cannot_add_input")
            return 1
        }
        session.addInput(input)

        let output = AVCaptureVideoDataOutput()
        let queue = DispatchQueue(label: "face-detect")
        output.setSampleBufferDelegate(self, queue: queue)
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
        ]
        guard session.canAddOutput(output) else {
            printResult(detected: false, error: "cannot_add_output")
            return 1
        }
        session.addOutput(output)

        // ── Capture one frame ───────────────────────────────────────────
        session.startRunning()

        // Wait up to 5 seconds for the first frame.
        let deadline = Date().addingTimeInterval(5.0)
        while !captured && Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }

        session.stopRunning()

        if !captured {
            printResult(detected: false, error: "timeout")
            return 1
        }

        return resultCode
    }

    // ── AVCaptureVideoDataOutputSampleBufferDelegate ────────────────
    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        // Only process the first frame.
        guard !captured else { return }
        captured = true

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            printResult(detected: false, error: "no_image_buffer")
            resultCode = 1
            return
        }

        // ── Vision face detection ───────────────────────────────────
        let request = VNDetectFaceRectanglesRequest()
        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:])

        do {
            try handler.perform([request])
            let faces = request.results ?? []
            let detected = !faces.isEmpty
            let confidence = faces.first?.confidence ?? 0
            printResult(detected: detected, confidence: confidence, faceCount: faces.count)
            resultCode = 0
        } catch {
            printResult(detected: false, error: "vision_error")
            resultCode = 1
        }
    }
}

// MARK: - Entry point

let detector = FaceDetector()
exit(detector.run())
