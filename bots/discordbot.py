import datetime
import logging
import nextcord
from nextcord.ext import commands
import aiohttp
import traceback
import sentry_sdk
import asyncio
from dotenv import load_dotenv
import os
from apiclient import APIClient

load_dotenv()

api_url = os.getenv("API_URL")  # Change this to your API URL
status_url = "https://status.astroid.cc/monitor/iamup/discord-beta"


sentry_sdk.init(
    dsn=os.getenv("SENTRY_DSN"),
    # Set traces_sample_rate to 1.0 to capture 100%
    # of transactions for performance monitoring.
    traces_sample_rate=1.0,
    # Set profiles_sample_rate to 1.0 to profile 100%
    # of sampled transactions.
    # We recommend adjusting this value in production.
    profiles_sample_rate=1.0,
) 

# Set up logging
logger = logging.getLogger('nextcord')
logger.setLevel(logging.DEBUG)
handler = logging.FileHandler(filename='nextcord.log', encoding='utf-8', mode='w')
handler.setFormatter(logging.Formatter('%(asctime)s:%(levelname)s:%(name)s: %(message)s'))
logger.addHandler(handler)

# Set up intents and create the bot client
intents = nextcord.Intents.all()
client = commands.Bot(command_prefix="gc!", intents=intents)



# Initialize API client
api_client = APIClient(api_url, os.getenv("MASTER_TOKEN"))

async def send_iamup():
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(status_url) as response:
                if response.status == 200:
                    print("IAMUP ping sent successfully.")
                else:
                    print(f"Failed to send IAMUP ping. Status code: {response.status}")
    except Exception as e:
        print("Error sending IAMUP ping:", e)

async def iamup_loop():
    while True:
        asyncio.create_task(send_iamup())
        await asyncio.sleep(40)


async def activity_task():
    while True:
        try:
            print("Updating activity..")
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{api_url}/statistics") as r:
                    data = await r.json()
                    await client.change_presence(activity=nextcord.Activity(type=nextcord.ActivityType.watching, name=f'{data["messages"]["total_rounded"]}+ messages | {data["endpoints"]} servers'))
        except Exception as e:
            print("Error updating activity:", e, "| will retry in 120 seconds.")
        await asyncio.sleep(120)

@client.event
async def on_ready():
    print(f"Logged in as {client.user} ({client.user.id})")
    client.loop.create_task(activity_task())
    client.loop.create_task(iamup_loop())

# Slash command to send an embed
@client.slash_command(name="send-embed")
async def send_embed(interaction: nextcord.Interaction):
    # Create an embed
    embed = nextcord.Embed(title="Test Title", description="Test Description")
    embed.add_field(name="Test Field", value="Test Field Value")
    embed.set_image(url="https://media1.tenor.com/m/YYPY5tPFIE8AAAAd/bad-teeth.gif")
    embed.set_thumbnail(url="https://media.pinatafarm.com/protected/B183D0EF-49B8-47BF-A523-E72FD0CFFAAC/Soyjak-Pointing.2.meme.webp")
    # Send the embed
    await interaction.channel.send("Test Message", embed=embed)
    await interaction.response.send_message("Embed sent successfully.")

# Event handler for message edit
@client.event
async def on_message_edit(before: nextcord.Message, after: nextcord.Message):
    # Get channel information from the API
    async with aiohttp.ClientSession() as session:
        async with session.get(f"{api_url}/{before.guild.id}?token={os.getenv('MASTER_TOKEN')}") as channel_request:
            if channel_request.status == 200:
                channel_json = await channel_request.json()
                if str(before.channel.id) in channel_json.get("config", {}).get("channels", {}).get("discord", {}):
                    # Create an embed with edited message information
                    embed = nextcord.Embed(title=f"{before.author.name} - Edited", description=after.content, colour=0xf5c400)
                    embed.add_field(name="Jump", value=after.jump_url)
                    embed.add_field(name="Before", value=before.content, inline=False)
                    embed.add_field(name="After", value=after.content, inline=False)
                    # Send the embed to the log channel
                    log_channel_id = channel_json.get("config", {}).get("logs", {}).get("discord")
                    if log_channel_id:
                        await client.get_channel(int(log_channel_id)).send(embed=embed)

# Event handler for new messages
@client.event
async def on_message(message: nextcord.Message):
    async with aiohttp.ClientSession() as session:
        try:
            # Get all config information from the API in one request
            async with session.get(f"{api_url}/{message.guild.id}?token={os.getenv('MASTER_TOKEN')}") as config_request:
                config_data = await config_request.json()
            # Check if channel is allowed
            if not config_data.get("isbeta", False):
                return
            # Check if the message is in a bridged channel
            if str(message.channel.id) in config_data.get("config", {}).get("channels", {}).get("discord", []):
                await asyncio.sleep(2)
                try:
                    message_still_exists = await message.channel.fetch_message(message.id)
                except nextcord.errors.NotFound:
                    print("Message deleted.")
                    return
                print("Message exists.")
                # Blacklist check
                for word in config_data.get("config", {}).get("blacklist", []):
                    if word and word.lower() in message.content.lower():
                        embed = nextcord.Embed(title=f"{message.author.name} - Flagged", description=message.content, colour=0xf5c400)
                        await message.delete()
                        # Send the embed to the log channel
                        log_channel_id = config_data.get("config", {}).get("logs", {}).get("discord")
                        if log_channel_id:
                            await client.get_channel(int(log_channel_id)).send(embed=embed)
                        return
                
                allowed_ids = config_data.get("config", {}).get("allowed_ids", [])
                if message.author.bot:
                    if str(message.author.id) not in allowed_ids:
                        return
                all_enpoint_webhooks = None
                discord_channel = config_data.get("config", {}).get("channels", {}).get("discord", {}).get(str(message.channel.id), {})
                if discord_channel.get("config").get("webhooks").get("discord"):
                    all_enpoint_webhooks = discord_channel.get("config").get("webhooks").get("discord")
                webhook_ids = [webhook.replace("https://discord.com/api/webhooks/", "").split("/")[0] for webhook in all_enpoint_webhooks]
                print(webhook_ids)
                print(str(message.author.id))
                msg_obj = {
                    "content": message.content,
                    "author": {
                        "name": message.author.name,
                        "avatar": message.author.avatar.url if message.author.avatar else f"{api_url}/assets/Astroid PFP not found.png",
                        "id": str(message.author.id)
                    },
                    "sender": "discord",
                    "sender-channel": str(message.channel.id)
                }
                # Attachments
                if message.attachments:
                    msg_obj["attachments"] = [a.url for a in message.attachments]
                # Embed
                if message.embeds:
                    emb = message.embeds[0]
                    embed_obj = {
                        "title": emb.title if emb.title else None,
                        "description": emb.description if emb.description else None,
                        "thumbnail": emb.thumbnail.url if emb.thumbnail else None,
                        "image": emb.image.url if emb.image else None,
                        "footer": emb.footer.text if emb.footer else None,
                        "fields": []
                    }
                    if emb.fields:
                        for field in emb.fields:
                            embed_obj["fields"].append({"name": field.name, "value": field.value, "inline": field.inline})
                    msg_obj["embed"] = embed_obj
                # Reply
                if message.reference and message.reference.resolved:
                    msg_obj["isReply"] = True
                    msg_obj["reply"] = {
                        "author": message.reference.resolved.author.name,
                        "message": message.reference.resolved.content
                    }
                # Sende die Nachricht als JSON an den /messages Endpoint
                async with session.post(
                    f"{api_url}/{message.channel.guild.id}/messages?token={os.getenv('MASTER_TOKEN')}",
                    json=msg_obj
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        print(f"Message sent to API successfully: {data}")
                    else:
                        print(f"Failed to send message to API: {resp.status}")
                        error_data = await resp.json()
                        print(f"Error: {error_data.get('message', 'No error message provided')}")
        except KeyError:
            traceback.print_exc()
            pass
        except AttributeError:
            pass
        except:
            traceback.print_exc()
            pass


# Event handler for message deletion
@client.event
async def on_message_delete(message: nextcord.Message):
    # Get channel information from the API
    print(message.guild.id)
    async with aiohttp.ClientSession() as session:
        async with session.get(f"{api_url}/{message.guild.id}?token={os.getenv('MASTER_TOKEN')}") as channel_request:
            if channel_request.status == 200:
                channel_json = await channel_request.json()
                if str(message.channel.id) in channel_json.get("config", {}).get("channels", {}).get("discord", {}):
                    print("Channel found")
                    # Create an embed with deleted message information
                    embed = nextcord.Embed(title=f"{message.author.name} - Deleted", description=message.content, colour=0xf5c400)
                    embed.add_field(name="Created at", value=f'{datetime.datetime.strftime(message.created_at, "%Y-%m-%d %H:%M:%S")} UTC')
                    # Send the embed to the log channel
                    log_channel_id = channel_json.get("config", {}).get("logs", {}).get("discord")
                    if log_channel_id:
                        log_channel = client.get_channel(int(log_channel_id))
                        if hasattr(log_channel, 'send'):
                            await log_channel.send(embed=embed)


# Slash command to register the server
@client.slash_command(name="register", default_member_permissions=8, description="Automatically register your server.")
async def register(interaction: nextcord.Interaction):
    await interaction.response.send_message("Starting registering process.. (This may take a while.)", ephemeral=True)
    try:
        async with aiohttp.ClientSession() as session:
            # Check if the API is reachable
            async with session.get(api_url) as r:
                if not r.ok:
                    return await interaction.edit_original_message(content="API is not reachable. Please try again later.")
            
            # Create a webhook for astroid
            if hasattr(interaction.channel, 'create_webhook'):
                webhook = await interaction.channel.create_webhook(name="astroid")
            else:
                return await interaction.edit_original_message(content="Cannot create webhook in this channel type.")
            
            # Create an endpoint in the API using the new endpoint
            async with session.post(f"{api_url}/create?token={os.getenv('MASTER_TOKEN')}", 
                                  json={"endpointId": interaction.guild.id}) as r1:
                if r1.status == 200:
                    endpoint_data = await r1.json()
                    await interaction.edit_original_message(content="Created endpoint. Updating values.. (This may take a while.)")
                    token = endpoint_data.get("token")
                else:
                    error_data = await r1.json()
                    return await interaction.edit_original_message(content=error_data.get("message"))
            
            # Update the endpoint configuration using the new API structure
            config_data = {
                "channels": {
                    "discord": [interaction.channel.id]
                },
                "webhooks": {
                    "discord": [webhook.url]
                }
            }
            
            async with session.post(f"{api_url}/{interaction.guild.id}/config?token={token}", 
                                  json=config_data) as r2:
                if r2.status == 200:
                    await interaction.edit_original_message(
                        content=f"Created endpoint: {api_url}/{interaction.guild.id}\n"
                               f"Your API Token is: `{token}`\n"
                               f"Save and **__do not__** share this!\n"
                               f"Hop over to Guilded and run this command in the channel, you want to bridge over: `a!register {interaction.guild.id}`"
                    )
                else:
                    error_data = await r2.json()
                    await interaction.edit_original_message(content=f"{error_data.get("message")}\n```{error_data.get("details")}```")
    except Exception as e:
        traceback.print_exc()
        await interaction.edit_original_message(content=f"An error occurred: {str(e)}")

# Slash command to add another channel for bridging
@client.slash_command(name="add-bridge", description="Add current channel for bridging", default_member_permissions=8)
async def add_bridge(interaction: nextcord.Interaction):
    await interaction.response.send_message("Adding bridge..", ephemeral=True)
    # Create a webhook for astroid
    try:
        if hasattr(interaction.channel, 'create_webhook'):
            webhook = await interaction.channel.create_webhook(name="astroid")
        else:
            return await interaction.edit_original_message(content="I need to be in a text channel to create a webhook.")
    except nextcord.errors.Forbidden:
        return await interaction.edit_original_message(content="I need the `Manage Webhooks` permission to create a webhook in this channel.")

    async with aiohttp.ClientSession() as session:
        # Get current endpoint data
        async with session.get(f"{api_url}/{interaction.guild.id}?token={os.getenv('MASTER_TOKEN')}") as get_response:
            if get_response.status == 200:
                current_data = await get_response.json()
                config_update = current_data.get("config", {})
                
                # Initialize channels structure if needed
                if "channels" not in config_update:
                    config_update["channels"] = {}
                if "discord" not in config_update["channels"]:
                    config_update["channels"]["discord"] = {} 
                
                # Update the endpoint configuration using the new API structure
                config_data = {
                    "channels": {
                        "discord": [interaction.channel.id]
                    },
                    "webhooks": {
                        "discord": [webhook.url]
                    }
                }

                async with session.post(f"{api_url}/{interaction.guild.id}/config?token={os.getenv('MASTER_TOKEN')}",
                                        json=config_data) as update_response:
                    if update_response.status == 200:
                        await interaction.edit_original_message(content="Added new channel for bridging. Execute bridge commands on other platforms to connect them to this channel.")
                    else:
                        error_data = await update_response.json()
                        await interaction.edit_original_message(content=error_data.get("message"))
            else:
                await interaction.edit_original_message(content="Could not retrieve endpoint data. Make sure the server is registered first.")
        



# Slash command to display help information
@client.slash_command(name="help")
async def help(interaction: nextcord.Interaction):
    embed = nextcord.Embed(title="astroid", description="API Docs: https://docs.astroid.cc", color=0x00ff00)
    embed.add_field(name="register", value="Register you server.", inline=False)
    embed.add_field(name="delete", value="Delete your endpoint.", inline=False)
    embed.add_field(name="generate-token", value="Generate a new token for your endpoint.", inline=False)
    embed.add_field(name="allow", value="Allow a bot or webhook to be forwarded.", inline=False)
    embed.add_field(name="set-log", value="Setup your logchannel.", inline=False)
    embed.add_field(name="add-bridge", value="Add another channel to bridge over.\nNote: Works like `register`", inline=False)
    await interaction.response.send_message(embed=embed, ephemeral=True)

# Slash command to delete the endpoint
@client.slash_command(name="delete", default_member_permissions=8, description="Delete your endpoint.")
async def delete(interaction: nextcord.Interaction):
    await interaction.response.send_message("Deleting your endpoint..", ephemeral=True)
    async with aiohttp.ClientSession() as session:
        # Delete the endpoint in the API using the new endpoint
        async with session.delete(f"{api_url}/delete?token={os.getenv('MASTER_TOKEN')}", 
                                json={"endpointId": interaction.guild.id}) as r:
            if r.status == 200:    
                await interaction.edit_original_message(content="Deleted endpoint.")
            else:    
                error_data = await r.json()
                await interaction.edit_original_message(content=error_data.get("message"))

# Slash command to set the log channel
@client.slash_command(name="set-log", default_member_permissions=8, description="Set logs")
async def setlog(interaction: nextcord.Interaction, channel: nextcord.TextChannel):
    await interaction.response.send_message("Setting logchannel..", ephemeral=True)
    async with aiohttp.ClientSession() as session:
        # Get current endpoint data
        async with session.get(f"{api_url}/{interaction.guild.id}?token={os.getenv('MASTER_TOKEN')}") as get_response:
            if get_response.status == 200:
                current_data = await get_response.json()
                # Update the log channel in the config
                config_update = current_data.get("config", {})
                if "logs" not in config_update:
                    config_update["logs"] = {}
                config_update["logs"]["discord"] = str(channel.id)
                
                async with session.post(f"{api_url}/{interaction.guild.id}/config?token={os.getenv('MASTER_TOKEN')}", 
                                      json=config_update) as update_response:
                    if update_response.status == 200:    
                        await interaction.edit_original_message(content="Set logchannel.")
                    else:
                        error_data = await update_response.json()
                        await interaction.edit_original_message(content=error_data.get("message"))
            else:
                await interaction.edit_original_message(content="Could not retrieve endpoint data.")

# Slash command to allow a webhook or bot
@client.slash_command(name="allow", default_member_permissions=8, description="Allow a webhook or bot")
async def allow(interaction: nextcord.Interaction, id: str):
    await interaction.response.send_message(f"Adding {id} to allowlist..", ephemeral=True)
    async with aiohttp.ClientSession() as session:
        # Get current endpoint data
        async with session.get(f"{api_url}/{interaction.guild.id}?token={os.getenv('MASTER_TOKEN')}") as get_response:
            if get_response.status == 200:
                current_data = await get_response.json()
                # Update the allowed IDs in the config
                config_update = current_data.get("config", {})
                if "allowed_ids" not in config_update:
                    config_update["allowed_ids"] = []
                if id not in config_update["allowed_ids"]:
                    config_update["allowed_ids"].append(id)
                
                async with session.post(f"{api_url}/{interaction.guild.id}/config?token={os.getenv('MASTER_TOKEN')}", 
                                      json=config_update) as update_response:
                    if update_response.status == 200:
                        await interaction.edit_original_message(content=f"Added {id} to allowlist.")
                    else:
                        error_data = await update_response.json()
                        await interaction.edit_original_message(content=error_data.get("message"))
            else:
                await interaction.edit_original_message(content="Could not retrieve endpoint data.")

# Slash command to generate a new API token
@client.slash_command(name="generate-token", default_member_permissions=8, description="Generate a new API Token.")
async def gen(interaction: nextcord.Interaction):
    await interaction.response.send_message("Generating token..", ephemeral=True)
    # Request a new token from the API
    async with aiohttp.ClientSession() as session:
        # Check if the API is reachable
        async with session.get(api_url) as r:
            if not r.ok:
                return await interaction.edit_original_message(content="API is not reachable. Please try again later.")
        
        async with session.post(f"{api_url}/newtoken?token={os.getenv('MASTER_TOKEN')}", 
                              json={"endpointId": interaction.guild.id}) as token_gen:
            if token_gen.status == 200:
                token_data = await token_gen.json()
                await interaction.edit_original_message(content=f"Your new API Token is: `{token_data['token']}`\nSave and **__do not__** share this!")
            else:
                error_data = await token_gen.json()
                await interaction.edit_original_message(content=error_data.get("message"))

# Run the bot
discord_token = os.getenv("BETA_DISCORD_TOKEN")
if discord_token:
    client.run(discord_token)
else:
    print("ERROR: DISCORD_TOKEN environment variable is not set!")
