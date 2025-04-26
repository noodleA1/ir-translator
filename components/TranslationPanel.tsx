import { useHookstate } from '@hookstate/core'
import { ChannelState } from '@ir-engine/client-core/src/social/services/ChannelService'
import { API } from '@ir-engine/common/src/API'
import React, { useEffect, useRef, useState } from 'react'
import { geminiTranslatorPath } from '../services/geminiTranslator/geminiTranslator.schema'
import { translationConfig } from '../services/geminiTranslator/translation-config'

interface Language {
  code: string
  name: string
}

const languages: Language[] = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ru', name: 'Russian' },
  { code: 'zh', name: 'Chinese' }
]

const TranslationPanel = () => {
  // State for text translation
  const [inputText, setInputText] = useState('')
  const [translatedText, setTranslatedText] = useState('')
  const [targetLanguage, setTargetLanguage] = useState('es')
  const [isTranslating, setIsTranslating] = useState(false)
  const [error, setError] = useState('')

  // State for voice translation
  const [isListening, setIsListening] = useState(false)
  const [transcription, setTranscription] = useState('')
  const [autoSendToChat, setAutoSendToChat] = useState(true)

  // WebSocket and audio refs
  const streamRef = useRef<MediaStream | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const vadProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const selectedMimeTypeRef = useRef<string>('audio/webm')

  // VAD state
  const [isSpeaking, setIsSpeaking] = useState(false)
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null)
  const speechTimerRef = useRef<NodeJS.Timeout | null>(null)
  const recentLevelsRef = useRef<number[]>([])
  const MAX_RECENT_LEVELS = 100

  // Channel state for chat integration
  const channelState = useHookstate(ChannelState)

  // Send translation to chat
  const sendToChat = (text: string, isTranslation: boolean = true) => {
    try {
      const currentChannel = channelState.currentChannelId.value
      if (!currentChannel) return

      // Format the message
      const prefix = isTranslation ? '🌐 Translation: ' : '🎤 Transcription: '
      const message = `${prefix}${text}`

      // Send to chat - silently handle any errors
      API.instance
        .service(geminiTranslatorPath)
        .create({
          channelId: currentChannel,
          text: message
        })
        .catch((err) => {
          // Log error to console but don't display to user
          console.error('Error sending to chat (silently handled):', err)
        })
    } catch (err) {
      // Log error to console but don't display to user
      console.error('Error sending to chat (silently handled):', err)
      // No setError call - we don't want to show errors to the user
    }
  }

  // Handle text translation
  const handleTranslate = async () => {
    if (!inputText.trim()) {
      setError('Please enter text to translate')
      return
    }

    setIsTranslating(true)
    setError('')
    setTranslatedText('')

    try {
      // Use the direct API endpoint for translation
      const apiUrl = translationConfig.apiUrl.replace('http://', '').replace('https://', '')
      const response = await fetch(`http://${apiUrl}/translate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: inputText,
          targetLang: targetLanguage
        })
      })

      const data = await response.json()

      if (data.translated) {
        setTranslatedText(data.translated)
      } else if (data.error) {
        setError(`Translation error: ${data.error}`)
      } else {
        setError('Translation failed')
      }
    } catch (err) {
      console.error('Translation error:', err)
      setError('Translation service error')
    } finally {
      setIsTranslating(false)
    }
  }

  // Calculate a dynamic threshold based on recent audio levels
  const calculateDynamicThreshold = (currentLevel: number): number => {
    // Add current level to recent levels
    recentLevelsRef.current.push(currentLevel)

    // Keep only the most recent levels
    if (recentLevelsRef.current.length > MAX_RECENT_LEVELS) {
      recentLevelsRef.current.shift()
    }

    // Calculate baseline (background noise level)
    // Using the 15th percentile as an estimate of background noise
    const sortedLevels = [...recentLevelsRef.current].sort((a, b) => a - b)
    const baselineIndex = Math.floor(sortedLevels.length * 0.15)
    const baseline = sortedLevels[baselineIndex] || 0

    // Set threshold above the baseline
    // The multiplier determines sensitivity - higher = less sensitive
    const thresholdMultiplier = 1.8
    const minThreshold = 10 // Minimum threshold to avoid false positives

    return Math.max(baseline * thresholdMultiplier, minThreshold)
  }

  // Detect speech using VAD
  const detectSpeech = (event: AudioProcessingEvent) => {
    if (!isListening) return

    // Get audio data from analyser
    const analyser = analyserRef.current
    if (!analyser) return

    // Get frequency data
    const buffer = new Uint8Array(analyser.frequencyBinCount)
    analyser.getByteFrequencyData(buffer)

    // Calculate average volume
    let sum = 0
    for (let i = 0; i < buffer.length; i++) {
      sum += buffer[i]
    }
    const average = sum / buffer.length

    // Calculate dynamic threshold
    const threshold = calculateDynamicThreshold(average)

    // Detect speech
    if (average > threshold) {
      if (!isSpeaking) {
        onSpeechStart()
      }

      // Reset silence timer if it's running
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current)
        silenceTimerRef.current = null
      }

      // Update speech timer
      if (!speechTimerRef.current) {
        speechTimerRef.current = setTimeout(() => {
          console.log('Speech continuing...')
          speechTimerRef.current = null
        }, 500)
      }
    } else if (isSpeaking) {
      // Reset speech timer if it's running
      if (speechTimerRef.current) {
        clearTimeout(speechTimerRef.current)
        speechTimerRef.current = null
      }

      // Start silence timer if not already running
      if (!silenceTimerRef.current) {
        silenceTimerRef.current = setTimeout(() => {
          onSpeechEnd()
          silenceTimerRef.current = null
        }, 1500) // 1.5 seconds of silence to end speech segment
      }
    }
  }

  // Store recorded audio chunks
  const recordedChunksRef = useRef<Blob[]>([])

  // Manual start recording
  const startRecording = async () => {
    console.log('Manually starting recording')

    try {
      // Clear any previous state
      setError('')
      setTranscription('')
      setTranslatedText('')
      recordedChunksRef.current = []

      // Get microphone access if we don't have it yet
      if (!streamRef.current) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 16000, // 16kHz for Gemini compatibility
            sampleSize: 16, // 16-bit PCM
            channelCount: 1, // Mono audio
            latency: 0.01 // Low latency
          }
        })
        streamRef.current = stream
      }

      // Create a new MediaRecorder
      const mimeTypes = ['audio/wav', 'audio/webm', 'audio/mp3', 'audio/ogg', 'audio/pcm']

      let selectedMimeType = ''
      for (const type of mimeTypes) {
        if (MediaRecorder.isTypeSupported(type)) {
          selectedMimeType = type
          console.log(`Using MIME type: ${selectedMimeType}`)
          break
        }
      }

      if (!selectedMimeType) {
        console.error('None of the required audio formats are supported')
        setError('Your browser does not support the required audio format')
        return
      }

      // Create a new MediaRecorder
      const mediaRecorder = new MediaRecorder(streamRef.current, {
        mimeType: selectedMimeType,
        audioBitsPerSecond: 16000 * 16, // 16kHz * 16-bit = 256kbps
        videoBitsPerSecond: 0 // No video
      })

      // Store audio chunks locally, don't send them yet
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunksRef.current.push(event.data)
          console.log(
            `Recorded audio chunk: ${event.data.size} bytes, total chunks: ${recordedChunksRef.current.length}`
          )
        }
      }

      // Start recording
      mediaRecorder.start(200) // 200ms chunks
      mediaRecorderRef.current = mediaRecorder
      setIsSpeaking(true)

      console.log('Started recording')
    } catch (err) {
      console.error('Error starting recording:', err)
      setError(`Failed to start recording: ${err.message}`)
    }
  }

  // Manual stop recording and send to server
  const stopAndSendRecording = async () => {
    console.log('Manually stopping recording and sending for translation')
    setIsSpeaking(false)

    // Stop the MediaRecorder
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        // We need to wait for the final dataavailable event
        mediaRecorderRef.current.addEventListener(
          'stop',
          () => {
            // Now send the recorded audio to the server
            sendRecordedAudioToServer()
          },
          { once: true }
        )

        // Stop recording
        mediaRecorderRef.current.stop()
        console.log('Stopped MediaRecorder')
      } catch (err) {
        console.error('Error stopping MediaRecorder:', err)
        setError(`Error stopping recording: ${err.message}`)
      }
    } else {
      console.warn('No active MediaRecorder to stop')
    }
  }

  // Send recorded audio to server
  const sendRecordedAudioToServer = async () => {
    console.log(`Sending ${recordedChunksRef.current.length} recorded audio chunks to server`)

    if (recordedChunksRef.current.length === 0) {
      setError('No audio recorded')
      return
    }

    try {
      // Create a blob from all recorded chunks
      // Use the MIME type that was selected when recording started
      const mimeType = selectedMimeTypeRef.current || 'audio/wav'
      const audioBlob = new Blob(recordedChunksRef.current, { type: mimeType })
      console.log(`Created audio blob: ${audioBlob.size} bytes`)

      // Create a FormData object to send the file
      const formData = new FormData()
      const extension = mimeType.split('/')[1] || 'wav'
      formData.append('audio', audioBlob, `recording.${extension}`)
      formData.append('targetLanguage', targetLanguage)

      // Show loading state
      setIsTranslating(true)

      // Send the audio file to the server using fetch
      const apiUrl = translationConfig.apiUrl.replace('http://', '').replace('https://', '')
      const response = await fetch(`http://${apiUrl}/chunk-translate`, {
        method: 'POST',
        body: formData
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.message || 'Error processing audio')
      }

      // Parse the response
      const result = await response.json()
      console.log('Received response:', result)

      // Update the UI with the transcription and translation
      if (result.transcription) {
        setTranscription((prev) => (prev ? `${prev}\n${result.transcription}` : result.transcription))

        // Send transcription to chat if enabled
        if (autoSendToChat && result.transcription.trim()) {
          sendToChat(result.transcription, false)
        }
      }

      if (result.translation) {
        setTranslatedText((prev) => (prev ? `${prev}\n${result.translation}` : result.translation))

        // Send translation to chat if enabled
        if (autoSendToChat && result.translation.trim()) {
          sendToChat(result.translation, true)
        }
      }

      // Clear recorded chunks
      recordedChunksRef.current = []
      mediaRecorderRef.current = null
    } catch (err) {
      console.error('Error sending audio to server:', err)
      setError(`Error sending audio: ${err.message}`)
    } finally {
      setIsTranslating(false)
    }
  }

  // Initialize WebSocket connection
  const initWebSocket = async () => {
    try {
      // Close any existing WebSocket connection
      if (socketRef.current) {
        try {
          socketRef.current.close()
        } catch (err) {
          console.error('Error closing existing WebSocket:', err)
        }
      }

      // Create WebSocket connection
      const apiUrl = translationConfig.apiUrl.replace('http://', '').replace('https://', '')
      const wsUrl = `ws://${apiUrl}`
      console.log('Connecting to WebSocket:', wsUrl)

      // Create new WebSocket connection
      const socket = new WebSocket(wsUrl)
      socketRef.current = socket

      // Set up WebSocket event handlers
      socket.onopen = () => {
        console.log('WebSocket connection established')
      }

      socket.onmessage = (event) => {
        try {
          const result = JSON.parse(event.data)
          console.log('Received from WebSocket:', result)

          // Handle session ID message
          if (result.type === 'session' && result.sessionId) {
            console.log(`Session established: ${result.sessionId}`)
          }

          // Handle transcription response
          if (result.type === 'transcription' && result.text) {
            console.log(`Received transcription: ${result.text}`)

            // Handle error messages
            if (
              result.text.includes('Audio processing error') ||
              result.text.includes('Error') ||
              result.text.includes('error') ||
              result.error === true
            ) {
              console.warn(`Received error message in transcription: ${result.text}`)
              setError(`Server reported: ${result.text}`)
            } else {
              // Only display and send valid transcriptions
              setTranscription((prev) => (prev ? `${prev}\n${result.text}` : result.text))

              // Send transcription to chat if enabled
              if (autoSendToChat && result.text.trim()) {
                sendToChat(result.text, false)
              }
            }
          }

          // Handle translation response
          if (result.type === 'translation' && result.text) {
            console.log(`Received translation: ${result.text}`)

            // Handle error messages
            if (
              result.text.includes('Translation error') ||
              result.text.includes('Error') ||
              result.text.includes('error') ||
              result.error === true
            ) {
              console.warn(`Received error message in translation: ${result.text}`)
              setError(`Server reported: ${result.text}`)
            } else {
              // Only display and send valid translations
              setTranslatedText((prev) => (prev ? `${prev}\n${result.text}` : result.text))

              // Send translation to chat if enabled
              if (autoSendToChat && result.text.trim()) {
                sendToChat(result.text, true)
              }
            }
          }
        } catch (err) {
          console.error('Error parsing WebSocket message:', err)
        }
      }

      socket.onerror = (error) => {
        console.error('WebSocket error:', error)
        setError('WebSocket connection error')
      }

      socket.onclose = () => {
        console.log('WebSocket connection closed')
      }
    } catch (err) {
      console.error('Error initializing WebSocket:', err)
      setError(`WebSocket error: ${err.message}`)
      throw err
    }
  }

  // These functions are no longer needed with the manual approach

  // Clean up on component unmount
  useEffect(() => {
    return () => {
      // Stop MediaRecorder if running
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          mediaRecorderRef.current.stop()
        } catch (err) {
          console.error('Error stopping MediaRecorder:', err)
        }
      }

      // Close WebSocket connection
      if (socketRef.current) {
        try {
          socketRef.current.close()
        } catch (err) {
          console.error('Error closing WebSocket:', err)
        }
      }

      // Stop microphone stream
      if (streamRef.current) {
        try {
          streamRef.current.getTracks().forEach((track) => track.stop())
        } catch (err) {
          console.error('Error stopping microphone stream:', err)
        }
      }
    }
  }, [])

  return (
    <div className="rounded-lg bg-white p-4 shadow-md" style={{ pointerEvents: 'auto' }}>
      <h2 className="mb-4 text-2xl font-bold">Translation Panel</h2>

      {/* Language Selection */}
      <div className="mb-4">
        <label className="mb-1 block text-sm font-medium text-gray-700">Target Language</label>
        <select
          value={targetLanguage}
          onChange={(e) => setTargetLanguage(e.target.value)}
          className="w-full rounded-md border border-gray-300 p-2"
          disabled={isTranslating}
        >
          {languages.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.name}
            </option>
          ))}
        </select>
      </div>

      {/* Text Translation */}
      <div className="mb-4">
        <label className="mb-1 block text-sm font-medium text-gray-700">Text to Translate</label>
        <textarea
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          className="w-full rounded-md border border-gray-300 p-2"
          rows={4}
          disabled={isTranslating}
          placeholder="Enter text to translate..."
        />
        <div className="flex space-x-2">
          <button
            onClick={handleTranslate}
            disabled={isTranslating || !inputText.trim()}
            className="mt-2 rounded-md bg-blue-600 px-4 py-2 text-white disabled:bg-blue-300"
          >
            {isTranslating ? 'Translating...' : 'Translate'}
          </button>

          {/* Clear Results Button */}
          <button
            onClick={() => {
              setInputText('')
              setTranslatedText('')
              setTranscription('')
              setError('')
            }}
            disabled={isTranslating || (!inputText.trim() && !translatedText && !transcription)}
            className="mt-2 rounded-md bg-green-600 px-4 py-2 text-white disabled:bg-green-300"
          >
            Clear All
          </button>
        </div>
      </div>

      {/* Voice Translation */}
      <div className="mb-4">
        <div className="mb-2 flex items-center">
          <h3 className="text-lg font-medium">Voice Translation</h3>
          <span className="ml-2 text-xs text-gray-500">(Speak in English)</span>
        </div>

        <div className="mb-2 flex space-x-2">
          <button
            onClick={startRecording}
            disabled={isSpeaking}
            className={`rounded-md bg-green-600 px-4 py-2 text-white disabled:bg-green-300`}
          >
            Start Recording
          </button>

          {isSpeaking && (
            <button
              onClick={stopAndSendRecording}
              className={`rounded-md bg-yellow-600 px-4 py-2 text-white`}
              disabled={isTranslating}
            >
              Stop & Translate
            </button>
          )}

          {isTranslating && <div className="text-sm text-blue-600">Processing audio... please wait</div>}

          <label className="flex items-center">
            <input
              type="checkbox"
              checked={autoSendToChat}
              onChange={(e) => setAutoSendToChat(e.target.checked)}
              className="mr-2"
            />
            <span className="text-sm">Auto-send to chat</span>
          </label>
        </div>

        {/* Status Indicator */}
        {isSpeaking && <div className="mb-2 text-sm text-green-600">Speech detected - recording...</div>}

        {/* Error Display */}
        {error && <div className="mb-2 text-sm text-red-600">{error}</div>}

        {/* Transcription Display */}
        <div className="mb-4">
          <label className="mb-1 block text-sm font-medium text-gray-700">Transcription</label>
          <div className="min-h-[100px] w-full rounded-md border border-gray-300 bg-gray-50 p-2">
            {transcription || 'No transcription yet. Click "Start Recording" to begin.'}
          </div>

          {/* Send to Chat Button */}
          {transcription && (
            <button
              onClick={() => sendToChat(transcription, false)}
              className="mt-2 rounded-md bg-blue-600 px-4 py-2 text-white"
            >
              Send Transcription to Chat
            </button>
          )}
        </div>

        {/* Translation Display */}
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Translation</label>
          <div className="min-h-[100px] w-full rounded-md border border-gray-300 bg-gray-50 p-2">
            {translatedText || 'Translation will appear here after you click "Stop & Translate".'}
          </div>

          {/* Send to Chat Button */}
          {translatedText && (
            <button
              onClick={() => sendToChat(translatedText, true)}
              className="mt-2 rounded-md bg-blue-600 px-4 py-2 text-white"
            >
              Send Translation to Chat
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default TranslationPanel
export { TranslationPanel }
