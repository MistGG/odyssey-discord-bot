import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js'
import type { GuildConfigManager } from '../../guildConfig.js'
import { fetchLatestPatchNoteMeta } from '../../lib/patchNotesApi.js'

function formatLeadMinutes(minutes: number[]): string {
  return minutes.join(', ')
}

export const setupCommand = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Configure raid alert channel, ping role, and lead times')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('alert-channel')
      .setDescription('Channel for raid train alerts')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Alert channel')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('ping-role')
      .setDescription('Role to ping on train alerts (omit role to clear)')
      .addRoleOption((opt) => opt.setName('role').setDescription('Ping role')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('lead-times')
      .setDescription('Minutes before train start to alert (default: 5)')
      .addIntegerOption((opt) =>
        opt.setName('first').setDescription('First lead time in minutes').setRequired(true).setMinValue(1).setMaxValue(120),
      )
      .addIntegerOption((opt) =>
        opt.setName('second').setDescription('Second lead time in minutes').setMinValue(1).setMaxValue(120),
      )
      .addIntegerOption((opt) =>
        opt.setName('third').setDescription('Third lead time in minutes').setMinValue(1).setMaxValue(120),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('patch-notes-channel')
      .setDescription('Channel for new Odyssey patch notes')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Patch notes channel')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('show').setDescription('Show current guild alert settings'),
  )

export async function handleSetupCommand(
  interaction: ChatInputCommandInteraction,
  guildConfig: GuildConfigManager,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true })
    return
  }

  const sub = interaction.options.getSubcommand()

  if (sub === 'alert-channel') {
    const channel = interaction.options.getChannel('channel', true)
    if (
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement
    ) {
      await interaction.reply({ content: 'Pick a text channel.', ephemeral: true })
      return
    }
    guildConfig.setAlertChannel(interaction.guildId, channel.id)
    await interaction.reply({
      content: `Raid alerts will post in <#${channel.id}>.`,
      ephemeral: true,
    })
    return
  }

  if (sub === 'ping-role') {
    const role = interaction.options.getRole('role')
    guildConfig.setPingRole(interaction.guildId, role?.id ?? null)
    await interaction.reply({
      content: role ? `Train alerts will ping ${role}.` : 'Ping role cleared.',
      ephemeral: true,
    })
    return
  }

  if (sub === 'lead-times') {
    const minutes = [
      interaction.options.getInteger('first', true),
      interaction.options.getInteger('second'),
      interaction.options.getInteger('third'),
    ].filter((n): n is number => n != null)

    const cfg = guildConfig.setLeadMinutes(interaction.guildId, minutes)
    await interaction.reply({
      content: `Lead times set to **${formatLeadMinutes(cfg.leadMinutes)}** minute(s) before spawn.`,
      ephemeral: true,
    })
    return
  }

  if (sub === 'patch-notes-channel') {
    const channel = interaction.options.getChannel('channel', true)
    if (
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement
    ) {
      await interaction.reply({ content: 'Pick a text channel.', ephemeral: true })
      return
    }

    await interaction.deferReply({ ephemeral: true })

    guildConfig.setPatchNotesChannel(interaction.guildId, channel.id)

    try {
      const latest = await fetchLatestPatchNoteMeta()
      if (latest) {
        guildConfig.setLastPostedPatchNoteId(interaction.guildId, latest.id)
      }
    } catch (err) {
      console.error('[setup] could not seed patch notes cursor:', err)
    }

    await interaction.editReply({
      content: `New patch notes will post in <#${channel.id}>. Use \`/patch-notes test\` to preview the latest note.`,
    })
    return
  }

  if (sub === 'show') {
    const cfg = guildConfig.get(interaction.guildId)
    const lines = [
      `**Alert channel:** ${cfg.alertChannelId ? `<#${cfg.alertChannelId}>` : 'not set'}`,
      `**Ping role:** ${cfg.pingRoleId ? `<@&${cfg.pingRoleId}>` : 'none'}`,
      `**Lead times:** ${formatLeadMinutes(cfg.leadMinutes)} min`,
      `**Patch notes channel:** ${cfg.patchNotesChannelId ? `<#${cfg.patchNotesChannelId}>` : 'not set'}`,
    ]
    await interaction.reply({ content: lines.join('\n'), ephemeral: true })
  }
}
