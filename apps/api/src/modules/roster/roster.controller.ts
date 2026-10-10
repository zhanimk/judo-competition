import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.types.js';
import {
  CreateClubDto,
  RosterCommitDto,
  RosterPreviewDto,
  EntryPreviewDto,
  EntryUpdateDto,
  EntryArchiveDto,
  EntryNameDto,
  EntryRestoreDto,
  EntryIdentityPreviewDto,
  EntryIdentityBindDto,
  AthleteDirectoryQueryDto,
} from './roster.dto.js';
import { RosterService } from './roster.service.js';

@Controller('tournaments')
export class RosterController {
  constructor(private readonly service: RosterService) {}
  @Get(':id/athletes') athletes(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() dto: AthleteDirectoryQueryDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.athletes(id, dto, user);
  }
  @Get(':id/clubs') clubs(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: Principal) {
    return this.service.clubs(id, user);
  }
  @Post(':id/clubs') createClub(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateClubDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.createClub(id, dto, user);
  }
  @Post(':id/roster/preview') preview(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RosterPreviewDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.preview(id, dto, user);
  }
  @Post(':id/roster') commit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RosterCommitDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.commit(id, dto, user);
  }
  @Get(':id/roster/archived') archived(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
  ) {
    return this.service.archived(id, user);
  }
  @Post(':id/roster/entries/:entryId/preview') previewEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: EntryPreviewDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.previewEntry(id, entryId, dto, user);
  }
  @Post(':id/roster/entries/:entryId/update') updateEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: EntryUpdateDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.updateEntry(id, entryId, dto, user);
  }
  @Post(':id/roster/entries/:entryId/archive') archiveEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: EntryArchiveDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.archiveEntry(id, entryId, dto, user);
  }
  @Post(':id/roster/entries/:entryId/name') correctName(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: EntryNameDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.correctName(id, entryId, dto, user);
  }
  @Post(':id/roster/entries/:entryId/restore') restoreEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: EntryRestoreDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.restoreEntry(id, entryId, dto, user);
  }
  @Post(':id/roster/entries/:entryId/identity/preview') previewIdentity(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: EntryIdentityPreviewDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.previewIdentity(id, entryId, dto, user);
  }
  @Post(':id/roster/entries/:entryId/identity') bindIdentity(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: EntryIdentityBindDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.bindIdentity(id, entryId, dto, user);
  }
}
