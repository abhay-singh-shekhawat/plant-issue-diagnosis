# System Architecture: Compound AI Agronomy Engine

This document outlines the four-phase architecture for a multi-channel crop disease diagnostic system that combines visual inference with geo-spatial environmental data.

---

## Phase 1: Ingestion and Routing (The Entry Points)
*Standardizing multi-channel data into a unified backend format.*

### **Step 1A: Web UI (React/Frontend)**
*   **Action:** User uploads a photo of the diseased crop and selects a location via map or browser GPS.
*   **Data Payload:** 
    ```json
    { "source": "web", "image_url": "...", "coordinates": {"lat": 26.91, "lon": 75.78} }
    ```
*   **Transmission:** Sends a `POST` request to the central backend API.

### **Step 1B: WhatsApp Interface (Node.js)**
*   **Action:** Farmer sends an image and a location pin to an automated number.
*   **Process:** A Node.js server (using `whatsapp-web.js`) intercepts the message, downloads the image, and extracts GPS coordinates.
*   **Data Payload:** 
    ```json
    { "source": "whatsapp", "user_number": "+91...", "image_data": "...", "coordinates": {"lat": 26.91, "lon": 75.78} }
    ```
*   **Transmission:** Routes payload to the central backend API.

---

## Phase 2: Parallel Data Processing (The "Split-Brain" Engine)
*Parallel tracks to reduce latency and maximize context.*

### **Track A: Visual Inference Pipeline**
1.  **Gemini API:** Identifies symptoms and returns a JSON array of suspected diseases.
2.  **Local ResNet:** Processes the image through a pre-trained CNN for pattern recognition.
    *   **Output A:** Aggregated prediction JSON with confidence scores.

### **Track B: Geo-Spatial Context Pipeline**
1.  **Weather API:** Queries historical data for temperature, humidity, and rainfall trends.
2.  **Soil/Satellite Mock API:** Returns regional soil profiles and simulated crop rotation data.
    *   **Output B:** Environmental risk JSON (e.g., "High humidity detected; Nitrogen depletion likely").

---

## Phase 3: The Agentic Synthesizer (The Reasoning Core)
*Merging vision and environment to eliminate false positives.*

*   **Action:** The backend passes **Output A** and **Output B** to an LLM (Gemini/OpenAI).
*   **The Prompt:** 
    *   *Role:* Expert Agronomist.
    *   *Task:* Correlate visual symptoms with environmental factors to confirm the most logical diagnosis.
*   **Result:** A strict JSON containing:
    *   `final_diagnosis`
    *   `reasoning` (Contextual confirmation)
    *   `actionable_remedy` (3 simple steps)

---

## Phase 4: Multi-Channel Delivery
*Routing the diagnosis back to the user in their preferred format.*

### **Step 4A: Web UI Response**
*   **Visuals:** React frontend triggers a map animation zooming into the coordinates.
*   **Display:** Renders a clean dashboard showing the diagnosis, remedy, and supporting weather/satellite data points.

### **Step 4B: WhatsApp Response**
*   **Action:** System detects `source: whatsapp`.
*   **Voice Integration:** Passes remedy text to a **TTS API** to generate a voice note in the regional language (e.g., Hindi).
*   **Delivery:** Sends a text summary followed immediately by the audio file for accessibility.

---

## Pitch Deck / PPT Suggestions

1.  **The Problem:** Highlight that photos alone are insufficient for diagnosis ("The False Positive Problem").
2.  **The Solution:** Introduce **Compound AI** to move from simple classification to reasoning.
3.  **The Architecture:** Use a block diagram showing the parallel tracks (Track A & B).
4.  **Interface Demo:** Show the dual approach: Web dashboards for admins vs. WhatsApp voice notes for farmers.
5.  **Technical Edge:** Mention `whatsapp-web.js` for zero-cost deployment and the hybrid **ResNet + Gemini** model redundancy.
