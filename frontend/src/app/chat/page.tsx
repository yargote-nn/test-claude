"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";
import { encryptMessage } from "@/lib/crypto";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

const UserSchema = z.object({
	id: z.number(),
	username: z.string(),
	public_key: z.string(),
});

const UserResponseSchema = z.object({
	user: UserSchema,
});

const WSMessageSchema = z.object({
	type: z.string(),
	sender_id: z.number(),
	receiver_id: z.number(),
	content: z.string(),
	aes_key: z.string().optional(),
	message_id: z.number().optional(),
	status: z.string().optional(),
});

type WSMessage = z.infer<typeof WSMessageSchema>;

const MessageSchema = z.object({
	id: z.number(),
	sender_id: z.number(),
	receiver_id: z.number(),
	content: z.string(),
	status: z.string(),
	expires_at: z.string(),
	aes_key: z.string().optional(),
});

type Message = z.infer<typeof MessageSchema>;

const MessageResponseSchema = z.array(MessageSchema);

type MessageResponse = z.infer<typeof MessageResponseSchema>;

export default function Chat() {
	const [username, setUsername] = useState("");
	const [messages, setMessages] = useState<MessageResponse>([]);
	const [partnerId, setPartnerId] = useState("");
	const [partnerPublicKey, setPartnerPublicKey] = useState("");
	const [userId, setUserId] = useState("");
	const [newMessage, setNewMessage] = useState("");
	const [token, setToken] = useState("");
	const [privateKey, setPrivateKey] = useState("");
	const router = useRouter();
	const { toast } = useToast();
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const wsRef = useRef<WebSocket | null>(null);

	const [isWebSocketReady, setIsWebSocketReady] = useState(false);

	const sendStatusUpdate = useCallback((messageId: number, status: string) => {
		console.log("Sending status update:", messageId, status);
		if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
			console.log("WebSocket is open, sending status update");
			wsRef.current.send(
				JSON.stringify({
					type: "status_update",
					message_id: messageId,
					status: status,
				}),
			);
		}
	}, []);

	useEffect(() => {
		const fetchPartnerInfo = async () => {
			try {
				const response = await fetch(
					`http://localhost:8080/api/users/${partnerId}`,
					{
						headers: { Authorization: `Bearer ${token}` },
					},
				);
				if (response.ok) {
					const responseData = await response.json();
					// console.log(responseData);
					const { data, success } = UserResponseSchema.safeParse(responseData);
					if (success) {
						const { user } = data;
						setPartnerPublicKey(user.public_key);
						fetchMessages();
					} else {
						toast({
							title: "No partner valid",
						});
					}
				} else {
					toast({
						title: "No partner found",
					});
				}
			} catch (error) {
				console.error("Error fetching partner info:", error);
				toast({
					title: "Error",
					description: "Please try again. Failed to fetch partner info",
					variant: "destructive",
				});
			}
		};

		const fetchMessages = async () => {
			try {
				const response = await fetch(
					`http://localhost:8080/api/messages?partner_id=${partnerId}`,
					{
						headers: { Authorization: `Bearer ${token}` },
					},
				);
				if (response.ok) {
					const dataResponse = await response.json();
					const { data, success } =
						MessageResponseSchema.safeParse(dataResponse);
					if (success) {
						for (const message of data) {
							if (message.aes_key && privateKey) {
								const { decryptedMessage } = await fetch("/api/decrypt", {
									method: "POST",
									headers: { "Content-Type": "application/json" },
									body: JSON.stringify({
										encryptedMessage: message.content,
										encryptedAESKey: message.aes_key,
										privateKey,
									}),
								}).then((res) => res.json());
								message.content = decryptedMessage;
							}

							// Enviar actualización de estado si el mensaje es "sent" y no es del usuario actual
							if (
								message.status === "sent" &&
								message.sender_id !== Number(userId)
							) {
								message.status = "received";
								sendStatusUpdate(message.id, "received");
							}
						}
						setMessages(data.reverse());
					} else {
						toast({
							title: "No messages found",
						});
					}
				} else {
					toast({
						title: "Fetch messages failed",
					});
				}
			} catch (error) {
				console.error("Error fetching messages:", error);
				toast({
					title: "Error",
					description: JSON.stringify(error),
					variant: "destructive",
				});
			}
		};

		if (partnerId && token && privateKey && userId) {
			fetchPartnerInfo();
		}
	}, [partnerId, toast, token, privateKey, userId, sendStatusUpdate]);

	const handleNewMessage = useCallback(
		async (data: WSMessage) => {
			console.log("New message received:", data);
			try {
				let decryptedContent = data.content;
				if (data.aes_key && privateKey) {
					const response = await fetch("/api/decrypt", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							encryptedMessage: data.content,
							encryptedAESKey: data.aes_key,
							privateKey,
						}),
					});
					const { decryptedMessage } = await response.json();
					decryptedContent = decryptedMessage;
				}
				console.log("Decrypted message:", decryptedContent);

				const newMessage: Message = {
					id: data.message_id ?? -1,
					sender_id: data.sender_id,
					receiver_id: data.receiver_id,
					content: decryptedContent,
					status: "received", // Cambiamos el estado a "received" inmediatamente
					expires_at: new Date().toISOString(),
					aes_key: data.aes_key,
				};

				setMessages((prev) => [...prev, newMessage]);

				// Enviamos la actualización de estado "received" al backend
				if (data.message_id) {
					sendStatusUpdate(data.message_id, "received");
				}
			} catch (error) {
				console.error("Error processing new message:", error);
				toast({
					title: "Error",
					description: "Failed to process new message",
					variant: "destructive",
				});
			}
		},
		[privateKey, toast, sendStatusUpdate],
	);

	const handleStatusUpdate = useCallback((data: WSMessage) => {
		console.log("Status update:", data.status, data.message_id);
		setMessages((prev) =>
			prev.map((message) => {
				if (message.id === data.message_id) {
					return { ...message, status: data.status || "sent" };
				}
				return message;
			}),
		);
	}, []);

	const handleMessageSent = useCallback((data: WSMessage) => {
		console.log("Message sent:", data.status);
		setMessages((prev) =>
			prev.map((message) =>
				message.id === -1
					? {
							...message,
							status: data.status || "sent",
							id: data.message_id ?? -1,
						}
					: message,
			),
		);
	}, []);

	useEffect(() => {
		const token = localStorage.getItem("token");
		const userId = localStorage.getItem("user_id");
		const username = localStorage.getItem("username");
		const privateKey = localStorage.getItem(`private_key_${userId}`);

		if (!token || !userId || !username || !privateKey) {
			router.push("/login");
			return;
		}

		setToken(token);
		setUserId(userId);
		setUsername(username);
		setPrivateKey(privateKey);

		// Iniciar la conexión WebSocket aquí
		const websocket = new WebSocket(`ws://localhost:8080/ws?token=${token}`);
		wsRef.current = websocket;

		websocket.onopen = () => {
			console.log("WebSocket connection established");
			setIsWebSocketReady(true);
		};

		websocket.onmessage = async (event) => {
			const { data, success } = WSMessageSchema.safeParse(
				JSON.parse(event.data),
			);
			//console.log("WebSocket message:", data);
			if (success) {
				switch (data.type) {
					case "new_message":
						await handleNewMessage(data);
						break;
					case "message_sent":
						handleMessageSent(data);
						break;
					case "status_update":
						handleStatusUpdate(data);
						break;
					default:
						console.log("Unknown message type:", data.type);
				}
			}
		};

		websocket.onerror = (event) => {
			console.error("WebSocket error:", event);
			setIsWebSocketReady(false);
		};

		websocket.onclose = (event) => {
			console.log("WebSocket connection closed:", event);
			setIsWebSocketReady(false);
		};

		return () => {
			websocket.close();
		};
	}, [router, handleNewMessage, handleStatusUpdate, handleMessageSent]);

	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, []);

	const sendMessageCallback = useCallback(async () => {
		if (!isWebSocketReady) {
			toast({
				title: "Error",
				description: "WebSocket connection is not ready. Please try again.",
				variant: "destructive",
			});
			return;
		}

		if (!newMessage.trim()) {
			toast({
				title: "Error",
				description: "Message cannot be empty.",
				variant: "destructive",
			});
			return;
		}

		const tomorrow = new Date(new Date().getTime() + 24 * 60 * 60 * 1000);
		const expiresAt = tomorrow.toISOString();

		try {
			const { encryptedMessage, encryptedAESKey } = await encryptMessage(
				newMessage,
				partnerPublicKey,
			);

			if (wsRef.current?.readyState === WebSocket.OPEN) {
				const messageToSend = JSON.stringify({
					type: "message",
					content: encryptedMessage,
					receiver_id: Number(partnerId),
					aes_key: encryptedAESKey,
					expires_at: expiresAt,
				});

				wsRef.current.send(messageToSend);

				const message: Message = {
					id: -1, // Temporary ID
					sender_id: Number(userId),
					content: newMessage,
					status: "sent",
					receiver_id: Number(partnerId),
					aes_key: "",
					expires_at: expiresAt,
				};

				setMessages((prev) => [...prev, message]);
				setNewMessage("");
			} else {
				throw new Error("WebSocket is not in OPEN state");
			}
		} catch (error) {
			console.error("Failed to send message:", error);
			toast({
				title: "Error",
				description: "Failed to send message. Please try again.",
				variant: "destructive",
			});
		}
	}, [
		newMessage,
		partnerId,
		partnerPublicKey,
		userId,
		isWebSocketReady,
		toast,
	]);

	const sendMessage = (e: React.FormEvent) => {
		e.preventDefault();
		sendMessageCallback();
	};

	return (
		<div className="flex flex-col h-screen p-4">
			<h1 className="text-2xl text-center font-bold mb-4">
				Chat of {username}
			</h1>
			<div className="flex-1 overflow-y-auto mb-4 space-y-2">
				{messages?.map((message) => (
					<div
						key={`${message.id} - ${message.content}`}
						className={"p-2 rounded-lg mx-auto bg-gray-200 max-w-md"}
					>
						{`${message.sender_id === Number.parseInt(userId) ? "You" : "Partner"}: ${message.content} : ${message.status}`}
					</div>
				))}
				<div ref={messagesEndRef} />
			</div>
			<form onSubmit={sendMessage} className="flex space-x-2">
				<Input
					type="text"
					value={partnerId}
					onChange={(e) => setPartnerId(e.target.value)}
					placeholder="Partner ID"
					className="flex-1"
				/>
				<Input
					type="text"
					value={newMessage}
					onChange={(e) => setNewMessage(e.target.value)}
					placeholder="Type a message..."
					className="flex-1"
				/>
				<Button type="submit">Send</Button>
			</form>
		</div>
	);
}
