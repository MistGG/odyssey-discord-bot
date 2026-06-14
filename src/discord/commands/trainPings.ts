import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  GuildMember,
} from 'discord.js'
import type { GuildConfigManager } from '../../guildConfig.js'

export const TRAIN_PINGS_RECEIVE_ID = 'odyssey:train-pings:receive'
export const TRAIN_PINGS_PAUSE_ID = 'odyssey:train-pings:pause'

const EMBED_COLOR = 0x3ee0ff

export function pingPromptRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(TRAIN_PINGS_RECEIVE_ID)
      .setLabel('Receive Pings')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(TRAIN_PINGS_PAUSE_ID)
      .setLabel('Pause Pings')
      .setStyle(ButtonStyle.Secondary),
  )
}

export function buildTrainPingsEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle('🚂 Join the train')
    .setDescription('Would you like to join the train?')
    .addFields(
      {
        name: 'Receive Pings',
        value: 'Get alerted before boss trains spawn.',
        inline: true,
      },
      {
        name: 'Pause Pings',
        value: 'Mute train alerts. Opt back in anytime.',
        inline: true,
      },
    )
    .setFooter({ text: 'Odyssey Calc · train raid alerts' })
}

export const trainPingsCommand = new SlashCommandBuilder()
  .setName('train-pings')
  .setDescription('Join or pause raid train ping alerts')

export const trainPingsPanelCommand = new SlashCommandBuilder()
  .setName('train-pings-panel')
  .setDescription('Post a public train ping opt-in message in this channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

async function resolveMember(interaction: ButtonInteraction): Promise<GuildMember | null> {
  if (!interaction.guild) return null
  if (interaction.member instanceof GuildMember) return interaction.member
  try {
    return await interaction.guild.members.fetch(interaction.user.id)
  } catch {
    return null
  }
}

async function handlePingToggle(
  interaction: ButtonInteraction,
  guildConfig: GuildConfigManager,
  subscribe: boolean,
): Promise<void> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: 'This only works in a server.', ephemeral: true })
    return
  }

  const roleId = guildConfig.get(interaction.guildId).pingRoleId
  if (!roleId) {
    await interaction.reply({
      content: 'No ping role is configured yet. Ask an admin to run `/setup ping-role`.',
      ephemeral: true,
    })
    return
  }

  const role = interaction.guild.roles.cache.get(roleId)
  const me = interaction.guild.members.me
  if (!role) {
    await interaction.reply({ content: 'The configured ping role no longer exists.', ephemeral: true })
    return
  }
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.reply({ content: 'I need **Manage Roles** to update ping subscriptions.', ephemeral: true })
    return
  }
  if (role.position >= me.roles.highest.position) {
    await interaction.reply({
      content: 'Move my role above the ping role in Server Settings → Roles.',
      ephemeral: true,
    })
    return
  }

  const member = await resolveMember(interaction)
  if (!member) {
    await interaction.reply({ content: 'Could not load your server profile.', ephemeral: true })
    return
  }

  const hasRole = member.roles.cache.has(roleId)

  if (subscribe) {
    if (hasRole) {
      await interaction.reply({
        content: `You already have **${role.name}**. Train pings are on.`,
        ephemeral: true,
      })
      return
    }
    await member.roles.add(roleId)
    await interaction.reply({
      content: `You're subscribed to train pings (**${role.name}**).`,
      ephemeral: true,
    })
    return
  }

  if (!hasRole) {
    await interaction.reply({ content: 'Train pings are already paused for you.', ephemeral: true })
    return
  }
  await member.roles.remove(roleId)
  await interaction.reply({
    content: 'Train pings paused. Hit **Receive Pings** anytime to rejoin.',
    ephemeral: true,
  })
}

export async function handleTrainPingsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true })
    return
  }

  await interaction.reply({
    embeds: [buildTrainPingsEmbed()],
    components: [pingPromptRow()],
    ephemeral: true,
  })
}

export async function handleTrainPingsPanelCommand(
  interaction: ChatInputCommandInteraction,
  guildConfig: GuildConfigManager,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true })
    return
  }

  if (!guildConfig.get(interaction.guildId).pingRoleId) {
    await interaction.reply({
      content: 'Set a ping role first with `/setup ping-role`.',
      ephemeral: true,
    })
    return
  }

  await interaction.reply({
    embeds: [buildTrainPingsEmbed()],
    components: [pingPromptRow()],
  })
}

export async function handleTrainPingsButton(
  interaction: ButtonInteraction,
  guildConfig: GuildConfigManager,
): Promise<void> {
  if (interaction.customId === TRAIN_PINGS_RECEIVE_ID) {
    await handlePingToggle(interaction, guildConfig, true)
    return
  }
  if (interaction.customId === TRAIN_PINGS_PAUSE_ID) {
    await handlePingToggle(interaction, guildConfig, false)
  }
}

export function isTrainPingsButton(customId: string): boolean {
  return customId === TRAIN_PINGS_RECEIVE_ID || customId === TRAIN_PINGS_PAUSE_ID
}
